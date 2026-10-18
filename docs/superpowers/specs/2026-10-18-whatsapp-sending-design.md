# WhatsApp sending — design

Date: 2026-10-18 · Status: draft for approval

## Why
Every week a new duty roster arrives and ~70 soldiers need their personal shifts. Today the site
shows each soldier's message, but someone has to copy and send ~70 WhatsApp messages by hand. The
goal: from the site, send each soldier their own shifts on WhatsApp, from a dedicated number,
in one action — reliably, with no duplicates and no guessed data. Needed weekly for ~5 weeks.

## Goals
- Send the weekly message to **all soldiers or to selected soldiers** from the existing messages
  screen (the per-soldier message view stays as it is today).
- The site **remembers phone numbers**: uploaded once as an Excel file, reused for every roster.
- Per-soldier **status**: not sent / sent / delivered / read / failed (with Meta's reason).
- **No accidental duplicates**: a soldier who already got this week's message is not sent it again
  unless the sender explicitly chooses to re-send.
- Anyone with the **shared access code** can send and update the phone list.
- Stay on **free plans** (Render free, Neon free). Meta charges per message (Utility, Israel).

## Non-goals
- Receiving or answering soldiers' replies (incoming messages are ignored).
- Per-person accounts, roles, or an audit of which commander sent.
- Scheduling sends for later.
- Editing the WhatsApp wording from the site (it's a Meta-approved template; changes = new approval).

## Anti-goals (would be a failure even if it works)
- Real names, phone numbers, rosters, Meta IDs or tokens in the public GitHub repo.
- Any secret (Meta token, app secret, DB URL, encryption key, access code) reaching the browser.
- A soldier receiving shifts that are not exactly what the roster file says, or someone else's shifts.
- Sending to a number matched to the wrong soldier by a loose name guess.
- Sending without the access code.

## Decided with the user
- **Meta WhatsApp Cloud API**, dedicated number (already set up, Connected, LIVE). The number must
  never be logged into the WhatsApp / WhatsApp Business phone app.
- **Template `duty_roster_week`** (Hebrew `he`, Utility; submitted, pending approval). Body:
  ```
  שלום {{1}},
  אלה השיבוצים שלך לפי קובץ השיבוץ לשבוע {{2}}:
  ראשון {{3}}
  שני {{4}}
  שלישי {{5}}
  רביעי {{6}}
  חמישי {{7}}
  שישי {{8}}
  שבת {{9}}
  ראשון {{10}}
  אם יש טעות בשיבוץ, פנו למפקד. בהצלחה!
  ```
  Footer: `הודעה אוטומטית ממערכת השיבוץ`.
  - `{{1}}` soldier display name; `{{2}}` `DD/MM עד DD/MM` (week's first and last day).
  - `{{3}}`–`{{10}}` = the 8 days Sunday→Sunday of the roster week, each `DD/MM: <shifts>` or
    `DD/MM: —`. Rosters run Sunday to the next Sunday (8 days), confirmed on real files.
  - Several shifts on one day → same line, joined with ` • `. Each shift = time label · place
    (+ "יחד עם …"), reusing the wording of today's `messages.js` (`timeLabel`, place, shared-with).
    A shift belongs to the day it **starts**; night shifts keep the existing
    "בין יום X ל־Y" label inside the line.
  - Template parameters cannot contain newlines/tabs or 4+ consecutive spaces.
- **Phone numbers stored in a free Neon Postgres** (Frankfurt). Chosen over browser storage and
  over Render Starter. Phone numbers are **encrypted** in the DB with a key that lives only in
  Render env vars.
- **One shared access code** for everyone who sends.
- Contacts Excel format: columns `שם`, `טלפון` (optional `הערה`, ignored). A starter file with the
  70 names from the two real rosters was already generated for the user (lives only on their Mac).
  Phone formats accepted: `050-1234567`, `0501234567`, `+972501234567`, `972…`; normalized to
  `9725XXXXXXXX`.

## How it works (builder's latitude within this)
**Contacts**
- Upload the contacts Excel (behind the access code) → replaces the stored list entirely.
- Stored per row: display name, name match key, encrypted phone, updated-at.
- Matching a roster soldier to a contact uses the same identity rules as `people.js`
  (`nameRelation(...) === 'same'`). A short-form / "related" match or more than one candidate is
  **not** used — the soldier is shown as "no number / ambiguous" instead.
- Invalid phone rows and duplicate names are reported on upload, not silently fixed.
- The messages screen shows per soldier: has number / no number / ambiguous.

**Sending**
- Messages screen gains a checkbox per soldier + "select all", a count, and a Send button.
  Soldiers without a number, ambiguous cells, units, or with message problems are not selectable.
- Before sending: a confirm step ("Send to N soldiers?").
- Server builds each message from the parsed roster (never from browser-supplied text), calls the
  Graph API `POST /{PHONE_NUMBER_ID}/messages` with the template, records the result.
- Sends run sequentially with a small delay; one failure doesn't stop the rest; the UI shows
  progress and final per-soldier results.
- **Duplicate guard**: a send record keyed by (week start date, soldier match key). If a record
  exists, the soldier shows "already sent <time>"; re-sending needs an explicit "send again".
  If the roster changed and the soldier's message differs from what was sent (compare a hash of
  the parameters), show "changed since sent" so the sender can choose to send an update.
- If the template isn't APPROVED (checked via Graph API, cached briefly), Send is disabled with
  a clear Hebrew explanation.
- Body length limit (1024 chars incl. parameters): if a soldier's message would exceed it, mark
  them as a problem and don't send.

**Statuses (webhook)**
- `GET/POST /webhooks/whatsapp`: verify-token handshake; POST signature checked with the app secret
  (`X-Hub-Signature-256`); status updates (`sent/delivered/read/failed` + error) update the send
  record by message id (wamid). Incoming user messages are ignored.
- Works on Render free: the service may be asleep, Meta retries.
- Requires: app subscribed to the WABA (`POST /{WABA_ID}/subscribed_apps`), webhook field
  `messages` subscribed, and the Meta app **published** (unpublished apps only receive dashboard
  test webhooks). Publishing needs a privacy-policy URL — a simple page on the site is fine.

**Access code**
- `SEND_CODE` env var. Entering it marks the session as authorized (existing in-memory session).
  Rate-limited attempts; compared in constant time. Required for contacts upload/view, sending,
  and send status. Viewing/searching rosters stays as today (no code).

**Data model (Neon, needs a migration script — none exists today)**
- `contacts(id, name, name_key, phone_enc, updated_at)`
- `sends(id, week_start, soldier_key, soldier_name, params_hash, wamid, status, error, sent_at,
  status_at)` unique on (week_start, soldier_key) for the latest send (or keep history + latest flag
  — builder's choice).
- A `npm run migrate` (idempotent SQL) run before first use; surface it in the README/deploy steps.

**Config (Render env vars, never in the repo)**
`WA_TOKEN`, `WA_PHONE_NUMBER_ID`, `WA_WABA_ID`, `WA_TEMPLATE_NAME` (=`duty_roster_week`),
`WA_APP_SECRET`, `WA_VERIFY_TOKEN`, `DATABASE_URL`, `PHONE_ENC_KEY`, `SEND_CODE`.
Missing WhatsApp config → the sending UI is hidden/disabled, the rest of the site works as today.

**Message problems (decided with the user)**
- **Double booking** (soldier overlap in "בעיות בשיבוץ"): still selectable and sent with all shifts
  exactly as in the roster; a warning chip is shown next to the soldier.
- **A shift that couldn't be read** (no identified date/time) or a shift outside the week: the soldier
  is blocked (not selectable) until the roster is fixed — never sent a partial list.

**Privacy policy page**
- Public page `/privacy` (Hebrew + short English), linked from the Meta app settings. Operator:
  **Nir Tituani**, contact **nirtituani13@gmail.com** (the user approved publishing these). Says:
  phone numbers are used only to send duty-roster messages, stored encrypted, deleted on request /
  replaced on each contacts upload; message statuses are kept for the duplicate guard; nothing is
  shared or sold.

## Constraints
- Public repo rules in `CLAUDE.md` apply: fictional test data only.
- Existing stack: Node 22, Express, vanilla JS, ExcelJS, node:test + supertest + jsdom. All tests
  must pass; Graph API and DB are mocked in tests.
- Hebrew RTL UI; time ranges written with "עד".
- The Meta token currently expires around 2026-12-18 (fine for 5 weeks).

## Left to the builder
- DB client library, encryption details (AES-256-GCM suggested), table/column naming.
- Exact UI layout of checkboxes/status chips within the existing design.
- Send pacing, retries on transient Graph errors (never retry after a definite failure).

## My calls (not explicitly decided by the user)
- The existing editable message wording (greeting/intro/closing) no longer applies to WhatsApp;
  the per-soldier preview shows exactly the template message that will be sent.
- Duplicate guard per week + soldier, with "changed since sent" detection.
- Ambiguous/related name matches are never auto-used for a phone number.
- Contacts upload replaces the whole list (no merge).
- **One week per send.** Sending uses the roster's selected week (the existing week-start setting,
  `weekStartOverride`); the duplicate key is that week's start date. The 8 day slots are that
  week's Sunday → next Sunday. A soldier with any shift outside those 8 days is a problem
  ("שיבוץ מחוץ לשבוע") and can't be selected — nothing is silently dropped. (The user normally
  uploads only the current tab, so this should be rare.)
- **Test send:** a "send test" action sends one chosen soldier's exact message to a test number
  (`WA_TEST_PHONE` env var), creates no send record, and bypasses the duplicate guard. Used before
  the first real send.
- **Meta setup split:** API-doable steps (`subscribed_apps`, template status) are scripted
  (`npm run wa:setup`); dashboard-only steps (webhook URL + verify token, publishing the app) are a
  short checklist in the README that the user follows.
