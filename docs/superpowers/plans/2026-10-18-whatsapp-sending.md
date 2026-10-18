# WhatsApp Sending Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Send each soldier their week's shifts on WhatsApp (Meta Cloud API template `duty_roster_week`) from the messages screen, with remembered phone numbers, per-soldier status, and no accidental duplicates.

**Architecture:** Pure core modules build the 10 template parameters and match contacts to soldiers. The server gains a repository (Postgres on Neon in production, in-memory in tests), a WhatsApp Graph API client with injectable `fetch`, access-code-protected send/contacts routes, and a signed webhook for statuses. The soldiers view gets a send panel.

**Tech Stack:** Node 22 ESM, Express 4, ExcelJS, `pg` (new dependency), node:crypto AES-256-GCM, node:test + supertest + jsdom.

**Spec:** `docs/superpowers/specs/2026-10-18-whatsapp-sending-design.md`

## Global Constraints

- PUBLIC repo: no real names, rosters, phone numbers, Meta IDs, tokens in code, tests, comments, commits. Fixtures stay fictional ("… דמה").
- No secret reaches the browser: `WA_TOKEN`, `WA_APP_SECRET`, `WA_VERIFY_TOKEN`, `DATABASE_URL`, `PHONE_ENC_KEY`, `SEND_CODE` are server env vars only. Never log request bodies, phone numbers, or message text.
- Env vars: `WA_TOKEN`, `WA_PHONE_NUMBER_ID`, `WA_WABA_ID`, `WA_TEMPLATE_NAME` (default `duty_roster_week`), `WA_TEMPLATE_LANG` (default `he`), `WA_APP_SECRET`, `WA_VERIFY_TOKEN`, `WA_TEST_PHONE`, `DATABASE_URL`, `PHONE_ENC_KEY` (32 bytes, base64), `SEND_CODE`. Missing any of the WhatsApp/DB/code vars → sending disabled, rest of site unchanged.
- Graph API base: `https://graph.facebook.com/v25.0`.
- Template params: exactly 10 strings; no `\n`, `\t`, or 4+ consecutive spaces; body with params filled ≤ 1024 chars.
- Hebrew UI; time ranges with "עד"; times in HTML inside `<bdi dir="ltr">`.
- `npm test` must pass after every task.

## Review Focus

1. Webhook statuses arriving out of order or repeated (`read` before `delivered`, `sent` twice) → stored status never moves backwards; unknown wamid ignored with 200.
2. Double-click on Send / two commanders sending at once → each (week, soldier) is sent at most once unless "send again" was chosen; the record is reserved before the API call.
3. Roster replaced or week changed between screen load and Send → 409 `stale`, nothing sent.
4. Excel stores phones as numbers (leading 0 lost: `501234567`), with spaces, dashes, `+972`, or `972` → all normalize to `972501234567`; landlines/garbage are reported, not stored.
5. Meta error on one soldier (invalid number 131026, rate limit 130429, 5xx) → that soldier `failed` with a Hebrew reason, the rest continue; rate-limit/5xx retried once after 2 s, definite failures never retried.

---

### Task 1: Template parameters (`src/core/wa-message.js`)

**Files:**
- Create: `src/core/wa-message.js`
- Test: `test/wa-message.test.js`

**Interfaces:**
- Consumes: `timeLabel`, `assignmentLine` logic from `src/core/messages.js` (export a new `shiftText(a)` there: the part of `assignmentLine` after the date — night label if any, time label, place, shared-with — without the leading `• ` and day label); `addDays`, `HEBREW_DAYS`, `nightBetween` from `dates.js`.
- Produces:
  - `TEMPLATE_BODY: string` — the approved body with `{{1}}`…`{{10}}` (copy verbatim from the spec).
  - `buildWaMessage(soldier, assignments, weekStart: 'YYYY-MM-DD' | null, { overlapIds = new Set() } = {}) → { params: string[10], text: string, problems: string[], warnings: string[], hash: string, sendable: boolean }`
    - `text` = `TEMPLATE_BODY` with params substituted + `\n\nהודעה אוטומטית ממערכת השיבוץ` (the footer), used for preview.
    - `hash` = sha256 hex of `JSON.stringify(params)`.

- [ ] **Step 1: Write failing tests** using `buildMainFixture()` like `test/messages.test.js`:
  - `params[0]` = soldier name; `params[1]` = `'11/10 עד 18/10'` for weekStart `'2026-10-11'`.
  - `params[2..9]` start with `11/10: `, `12/10: ` … `18/10: `; a day without shifts is exactly `'DD/MM: —'`.
  - two shifts on one day → one param joined by `' • '` in start order (use `גדי דמה` on 12/10: `'12/10: 06:00 עד 14:00 · סיור / מפקד – סיור • 08:00 עד 12:00 · סטטיות / ש״ג'`).
  - night shift keeps `בין יום X ל־Y` inside its start day's line.
  - no param contains `\n`, `\t`, or `/ {4,}/`; `text.split('\n')` has 11 body lines + blank + footer.
  - blocked (`sendable: false`, problem text present) when: soldier `ambiguous`; any assignment with `kind !== 'timed'`; a shift starting before `weekStart` or after `weekStart + 7`; no timed shifts; `weekStart === null`; filled body > 1024 chars (build a soldier with many long fake shifts).
  - overlap → `sendable: true` and `warnings` contains `'שיבוץ כפול'` text when an assignment id is in `overlapIds`.
  - same input → same `hash`; one changed shift → different `hash`.
- [ ] **Step 2: Run** `npm test` → new tests FAIL (module missing).
- [ ] **Step 3: Implement.** Group timed assignments by `start.date`; sort by `startKey`; collapse runs of spaces in each param to one space as a final safety step.
- [ ] **Step 4: Run** `npm test` → all PASS.
- [ ] **Step 5: Commit** `git commit -m "WhatsApp template parameters from a soldier's week"`

### Task 2: Phones and contacts (`src/core/phones.js`, `src/core/contacts.js`)

**Files:**
- Create: `src/core/phones.js`, `src/core/contacts.js`
- Modify: `test/fixtures/build.js` (add `buildContactsFixture(rows)` → xlsx Buffer with header row `שם | טלפון | הערה`)
- Test: `test/contacts.test.js`

**Interfaces:**
- Produces:
  - `normalizePhone(value: string|number|null) → string|null` — Israeli mobile only → `'9725XXXXXXXX'` (12 digits).
  - `parseContactsWorkbook(buffer) → Promise<{ contacts: [{ name, phone }], errors: [{ row: number, message: string }] }>` — finds the header row by cells `שם` and `טלפון` (any column order, trimmed, first sheet that has both); skips fully empty rows; a name without phone is silently skipped (not an error — the user fills gradually); invalid phone → error `שורה N: מספר טלפון לא תקין`; same name (by `nameRelation === 'same'`) twice with a phone → error `שורה N: השם מופיע פעמיים` and both dropped.
  - `matchContacts(soldiers, contacts) → Map<soldierKey, { status: 'ok', phone } | { status: 'none' } | { status: 'ambiguous' }>` — `ok` only when exactly one contact has `nameRelation(soldier.name or any spelling, contact.name) === 'same'`; >1 → `ambiguous`; `'related'` never counts.

- [ ] **Step 1: Write failing tests:**
  - `normalizePhone`: `'050-1234567'`, `'0501234567'`, `'+972 50 123 4567'`, `'972501234567'`, `501234567` (number), `'050 123 4567 '` → `'972501234567'`; `'03-1234567'`, `'12345'`, `''`, `null` → `null`.
  - workbook: columns in order `טלפון | שם` still parsed; header on row 3 (title rows above) parsed; invalid phone row reported with its Excel row number; duplicate name reported and dropped.
  - match: exact name → ok; spelling variant (`נוה דמה` vs `נווה דמה`) → ok; short form `כהן` vs `אור כהן` → none; two contacts matching → ambiguous.
- [ ] **Step 2: Run** `npm test` → FAIL.
- [ ] **Step 3: Implement** with ExcelJS via existing `readWorkbook` from `src/core/workbook.js` if its grid output fits; otherwise ExcelJS directly.
- [ ] **Step 4: Run** `npm test` → PASS.
- [ ] **Step 5: Commit** `git commit -m "Contacts Excel: phone normalization and soldier matching"`

### Task 3: Repository, encryption, migration (`server/repo.js`)

**Files:**
- Create: `server/crypto.js`, `server/repo.js`, `server/migrations/001_init.sql`, `scripts/migrate.js`
- Modify: `package.json` (dependency `pg`; script `"migrate": "node scripts/migrate.js"`)
- Test: `test/repo.test.js`

**Interfaces:**
- Produces:
  - `createCipher(base64Key) → { encrypt(text) → string, decrypt(string) → text }` — AES-256-GCM, random 12-byte IV, output `base64(iv|tag|ciphertext)`; throws on key length ≠ 32.
  - Repo interface (both implementations, all methods async):
    - `replaceContacts([{ name, phone }])` — one transaction: delete all, insert all.
    - `listContacts() → [{ name, phone }]` (decrypted)
    - `contactsInfo() → { count, updatedAt }`
    - `reserveSend({ weekStart, soldierKey, soldierName, paramsHash, resend }) → { ok: true } | { ok: false, existing }` — inserts a row with status `'sending'`; if a row exists for (weekStart, soldierKey): when `resend` is true and existing status is not `'sending'`, overwrite it; otherwise return `{ ok: false, existing }`.
    - `completeSend({ weekStart, soldierKey, wamid, status: 'accepted' | 'failed', error })`
    - `listSends(weekStart) → Map<soldierKey, { status, error, paramsHash, sentAt, statusAt }>`
    - `applyStatus({ wamid, status: 'sent'|'delivered'|'read'|'failed', error, at })` — rank `accepted 0 < sent 1 < delivered 2 < read 3`; `failed` always applies unless current is `read`; never lowers rank; unknown wamid → no-op.
  - `createMemoryRepo()` and `createPgRepo({ databaseUrl, cipher })` (Neon needs `ssl: { rejectUnauthorized: true }`; use `pg.Pool` with `max: 3`).
- Schema (`001_init.sql`, idempotent with `IF NOT EXISTS`):
  ```sql
  CREATE TABLE IF NOT EXISTS contacts (id serial PRIMARY KEY, name text NOT NULL, phone_enc text NOT NULL, updated_at timestamptz NOT NULL DEFAULT now());
  CREATE TABLE IF NOT EXISTS sends (week_start date NOT NULL, soldier_key text NOT NULL, soldier_name text NOT NULL, params_hash text NOT NULL, wamid text, status text NOT NULL, error text, sent_at timestamptz NOT NULL DEFAULT now(), status_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (week_start, soldier_key));
  CREATE INDEX IF NOT EXISTS sends_wamid ON sends (wamid);
  ```
  `reserveSend` in Postgres = `INSERT … ON CONFLICT (week_start, soldier_key) DO UPDATE … WHERE $resend AND sends.status <> 'sending' RETURNING *` (no row returned → not reserved).

- [ ] **Step 1: Write failing tests** against `createMemoryRepo()` (one shared contract test suite function `repoContract(makeRepo)` so a Postgres run can reuse it when `TEST_DATABASE_URL` is set; skip otherwise):
  - cipher round-trips; two encryptions of the same phone differ; wrong key fails to decrypt.
  - `replaceContacts` replaces, `contactsInfo().count` matches.
  - second `reserveSend` without `resend` → `ok: false`; with `resend` after `completeSend` → `ok: true`; with `resend` while `'sending'` → `ok: false`.
  - `applyStatus`: `read` then `delivered` stays `read`; `failed` after `sent` → `failed`; unknown wamid → no throw.
- [ ] **Step 2: Run** `npm test` → FAIL.
- [ ] **Step 3: Implement** both repos and `scripts/migrate.js` (reads `DATABASE_URL`, runs every `server/migrations/*.sql` in name order, prints `migrations applied`).
- [ ] **Step 4: Run** `npm test` → PASS.
- [ ] **Step 5: Commit** `git commit -m "Repository for contacts and send records (Postgres + memory)"`

### Task 4: WhatsApp client (`server/whatsapp.js`)

**Files:**
- Create: `server/whatsapp.js`
- Test: `test/whatsapp.test.js`

**Interfaces:**
- Produces: `createWhatsAppClient({ token, phoneNumberId, wabaId, templateName, templateLang, fetch = globalThis.fetch, sleep = (ms) => new Promise(r => setTimeout(r, ms)), now = Date.now })` →
  - `sendTemplate(to: string, params: string[]) → Promise<{ ok: true, wamid } | { ok: false, error: string }>` — POST `/{phoneNumberId}/messages` body `{ messaging_product: 'whatsapp', to, type: 'template', template: { name, language: { code }, components: [{ type: 'body', parameters: params.map(text => ({ type: 'text', text })) }] } }`. Retries once after `sleep(2000)` on HTTP 5xx, network error, or Graph code `130429`/`131048`/`80007`. Never throws.
  - `templateStatus() → Promise<'APPROVED' | 'PENDING' | 'REJECTED' | 'MISSING' | 'ERROR'>` — GET `/{wabaId}/message_templates?name=…&fields=name,status,language`, picks the entry with matching language; cached 5 minutes (`now`).
  - `describeError(code) → string` Hebrew: `131026` → `המספר אינו זמין ב־WhatsApp`, `130429`/`131048` → `חריגה ממגבלת שליחה של Meta`, `132000`–`132015` → `בעיה בתבנית ההודעה`, `190` → `אסימון הגישה של Meta אינו תקף`, other → `שגיאת Meta (קוד N)`.
- [ ] **Step 1: Write failing tests** with a fake `fetch` recording calls: exact request URL/body/`Authorization: Bearer` header; success returns wamid; 131026 → `ok: false` with Hebrew text and no retry; 130429 then success → one retry; 500 twice → failed; template status cached (second call no fetch), language mismatch → `MISSING`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `git commit -m "WhatsApp Cloud API client"`

### Task 5: Access code + send/contacts routes (`server/send-routes.js`)

**Files:**
- Create: `server/send-routes.js`, `server/config.js`
- Modify: `server/app.js` (accept `{ wa, repo, sendCode, testPhone }` options; mount routes; remove the editable-template endpoints and `templateOf`; `/api/messages/preview` returns `buildWaMessage` results with `weekStart = req.session.data.roster.weekStart?.date ?? null`), `server/index.js` (build config from env via `loadConfig(process.env)`), `src/core/messages.js` (drop `DEFAULT_TEMPLATE`, `validateTemplate`, `TemplateError`, `buildMessage` if no longer used — keep `timeLabel`, `shiftText`), `test/messages.test.js`, `test/server.test.js`
- Test: `test/send.test.js`

**Interfaces:**
- Consumes: Tasks 1–4.
- Produces:
  - `loadConfig(env) → { enabled: boolean, missing: string[], wa: clientOptions, databaseUrl, encKey, sendCode, testPhone }`.
  - Routes (all JSON, all under `requireRoster`; all except `/api/auth` also require `session.authorized === true` → else 401 `{ error: 'auth' }`; when config disabled → 503 `{ error: 'disabled' }`):
    - `POST /api/auth { code }` → 204 and `session.authorized = true` if `crypto.timingSafeEqual` on sha256 digests; 401 otherwise; own rate limiter 10 / 15 min per IP.
    - `GET /api/send/state?rosterVersion=` → `{ enabled, authorized, template: status, weekStart, contacts: { count, updatedAt }, soldiers: [{ key, contact: 'ok'|'none'|'ambiguous', sendable, problems, warnings, send: { status, error, sentAt, changed } | null }] }` — `changed = send.paramsHash !== current hash`. Never includes phone numbers. (`enabled`/`authorized` are returned even when not authorized; the rest only when authorized.)
    - `POST /api/contacts` (multipart `file`, `.xlsx` check like roster upload) → `{ count, errors }`; replaces stored contacts only if `count > 0`.
    - `POST /api/send { personKeys (1–20), rosterVersion, resend: boolean }` → `{ results: [{ key, status: 'accepted'|'failed'|'skipped', reason }] }`. Order per key: stale check (409) → template must be `APPROVED` (else 409 `{ error: 'template' }`) → soldier sendable and contact `ok` (else `skipped` with reason) → `reserveSend` (not reserved → `skipped`, reason `נשלח כבר`) → `sendTemplate` → `completeSend`. Sequential, 150 ms between sends.
    - `POST /api/send/test { personKey, rosterVersion }` → sends that soldier's params to `testPhone`, no repo writes; 400 if `testPhone` unset.
- [ ] **Step 1: Write failing tests** with `createMemoryRepo()`, a fake WhatsApp client object, and supertest:
  - every send/contacts route → 401 before `/api/auth`; wrong code → 401; 11th attempt → 429.
  - `GET /api/send/state` JSON contains no digits sequence matching `/9725\d{8}/`.
  - send happy path → client called with normalized phone and Task 1 params; state shows `accepted`.
  - second send same soldier without `resend` → `skipped`, client not called; with `resend: true` → sent again.
  - two concurrent `POST /api/send` for the same key (Promise.all) → client called once.
  - stale `rosterVersion` → 409, client not called; template `PENDING` → 409.
  - blocked soldier (unresolved shift) → `skipped`; overlap soldier → sent.
  - test send → client called with `testPhone`; `listSends` empty afterwards.
  - config disabled → `GET /api/send/state` returns `{ enabled: false }`, other routes 503; existing roster/search tests still pass.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → all PASS (update the old template/preview tests to the new preview shape).
- [ ] **Step 5: Commit** `git commit -m "Access code, contacts upload and WhatsApp send routes"`

### Task 6: Status webhook (`server/webhook.js`)

**Files:**
- Create: `server/webhook.js`
- Modify: `server/app.js` (mount **before** `express.json`, with `express.raw({ type: 'application/json', limit: '1mb' })`)
- Test: `test/webhook.test.js`

**Interfaces:**
- Produces: `webhookRouter({ repo, appSecret, verifyToken, log })`:
  - `GET /webhooks/whatsapp` — `hub.mode === 'subscribe'` and `hub.verify_token === verifyToken` → 200 with `hub.challenge` as text; else 403.
  - `POST /webhooks/whatsapp` — `X-Hub-Signature-256` must equal `sha256=` + HMAC-SHA256(appSecret, raw body) (timing-safe) → else 401. For each `entry[].changes[].value.statuses[]` call `repo.applyStatus({ wamid: s.id, status: s.status, error: s.errors?.[0] ? describeError(s.errors[0].code) : null, at: new Date(Number(s.timestamp) * 1000) })`. Ignore `messages[]`. Always 200 once the signature is valid (even for malformed JSON — log a short warning without the body).
- [ ] **Step 1: Write failing tests:** verify handshake ok/403; bad signature 401; valid signed payload with `delivered` then `read` then `delivered` → final `read`; `failed` with code 131026 → error text; incoming `messages` payload → 200, no repo call.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `git commit -m "WhatsApp status webhook with signature check"`

### Task 7: Send panel UI (`public/js/send-panel.js`) + privacy page

**Files:**
- Create: `public/js/send-panel.js`, `public/privacy.html`
- Modify: `public/index.html` (soldier view: remove the template `<details>` and the "not connected" notice; add a send panel container: access-code form, contacts upload + "N מספרים שמורים, עודכן …", template status line, "שליחה לנבחרים", "שליחת בדיקה למספר שלי" on the soldier detail, progress line), `public/js/soldiers-view.js` (remove template code; per-soldier chips from `/api/send/state`: `אין מספר` / `שם לא חד־משמעי` / `נשלח ✓` `נמסר ✓✓` `נקרא ✓✓` (blue) / `נכשל: <reason>` / `השתנה מאז השליחה`; `eligible` = state `sendable && contact === 'ok'`), `public/styles.css`, `test/soldiers-ui.test.js`
- Test: `test/send-ui.test.js` (jsdom, fake `api`)

**Interfaces:**
- Consumes: Task 5 routes.
- Produces: `createSendPanel({ api, getRoster, onStateChange(state) })` → `{ refresh() }`.
- Behavior:
  - Not authorized → only the code form is shown; after success → refresh.
  - Send: confirm dialog `לשלוח הודעה ל־N חיילים?` (`N` already-sent soldiers among them listed with an explicit checkbox `לשלוח שוב גם למי שכבר קיבל`); sends in chunks of 5 via `POST /api/send`, updating `נשלחו X מתוך N`; at the end shows counts accepted/failed/skipped and refreshes state.
  - Template not `APPROVED` → send buttons disabled with `התבנית עדיין ממתינה לאישור Meta` / `התבנית נדחתה`.
  - State auto-refreshes every 20 s while the soldiers tab is visible and any send is not yet `delivered`/`read`/`failed`.
  - Preview shows the server's `text` in the existing `messageBlock` (problems as ⚠, warnings as ⚠ too, copy button stays).
- `privacy.html`: standalone page (own doctype, same fonts/styles), Hebrew then short English, operator **Nir Tituani**, contact **nirtituani13@gmail.com**, content per spec "Privacy policy page". Linked in the site footer.
- [ ] **Step 1: Write failing jsdom tests:** code form shown when unauthorized; chips rendered per state; send button disabled while template pending; confirm → two chunks for 7 selected soldiers; already-sent soldier sent only when the resend box is checked; `/privacy.html` served with 200 and contains the operator email.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** `npm test` → PASS.
- [ ] **Step 5: Manual check:** `PORT=3100 npm start` with a fake-mode env (`WA_*` set to dummy values and a local fake: `WA_FAKE=1` makes `loadConfig` build an in-memory repo and a client that returns fake wamids — add this flag in `server/config.js`, ignored when `NODE_ENV=production`) → upload the fictional fixture, enter code, upload a fictional contacts file, send, see chips; check on iPhone width.
- [ ] **Step 6: Commit** `git commit -m "Send panel, status chips and privacy page"`

### Task 8: Setup script, Render config, README checklist

**Files:**
- Create: `scripts/wa-setup.js`
- Modify: `package.json` (`"wa:setup": "node scripts/wa-setup.js"`), `render.yaml` (add every env var from Global Constraints with `sync: false`, except `WA_TEMPLATE_NAME`/`WA_TEMPLATE_LANG` with values), `README.md`, `CLAUDE.md` (replace "Next: WhatsApp sending (not built yet)" with a short "WhatsApp sending" section: modules, env vars, migration, test send)

- `wa-setup.js`: reads env; `POST /{WA_WABA_ID}/subscribed_apps`; prints template status and phone number status; prints the webhook URL to paste (`https://idf-mission-helper.onrender.com/webhooks/whatsapp`). Prints nothing secret.
- README checklist (Hebrew + commands): create Neon project (Frankfurt) → copy connection string → `DATABASE_URL=… npm run migrate` → generate `PHONE_ENC_KEY` with `node -e "console.log(crypto.randomBytes(32).toString('base64'))"` → set Render env vars → `npm run wa:setup` → Meta app dashboard: Webhooks → callback URL + verify token, subscribe field `messages`; App settings → Basic → privacy policy URL `/privacy.html`; publish the app → test send → real send.
- [ ] **Step 1:** Implement; `npm test` → PASS.
- [ ] **Step 2: Commit** `git commit -m "WhatsApp setup script, Render env vars and deployment checklist"`
