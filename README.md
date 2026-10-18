# duty-roster — ניהול שיבוץ תורנויות

Upload an Excel duty roster, see exactly what was parsed (and what wasn't), and answer
"who is on duty at <date> <hour> at <post>?" — strictly from the uploaded file.

**Status:** working and tested — upload → parse → validate → date/hour/post search, the
by-soldier view with personal message previews (copy only), the weekly duty board, and a flexible
shift search (any combination of day / hour / job / soldier).
WhatsApp sending (contacts upload, template send, delivery status) is built; it stays disabled until configured — see the checklist under Deployment.

## Run

```bash
npm install
npm test        # 107 tests: parsing, validation, searches, identity, messages, weekly board, sessions/privacy, UI
npm start       # http://localhost:3000
```

Node ≥ 22.15. Config via env vars — see `.env.example`.

## How the workbook is read

The supported roster format is a sheet with several stacked tables. The parser finds tables by structure,
not by hard-coded post names:

| Element | Rule |
|---|---|
| Table header | a row containing `יום` or `מתאריך – עד`; continues right through contiguous non-empty cells |
| Table title | the cell directly above the header (usually a merged title row) |
| Columns | `יום` day · `שעות` hours · `משימה` task · `מתאריך – עד` date range · anything else = a person column labelled by its header |
| Rows | until a blank row, the next header, or the next table's title |
| Post/role options | table title → its column headers (or its `משימה` values). Nothing else. |
| Cells outside any table | ignored, listed as an info note |
| Name without a task | ignored, listed as an info note |

**Dates.** Day cells may hold a day name only (`ראשון`) or a day and date without a year (`ראשון 11/10`). The week start is the Sunday on/before
the earliest explicit date; the year is the one in which that date falls on the stated weekday,
within ~6 months of today. Day-name-only rows are dated consecutively from the week start. The UI shows
which cell the week start came from, and the user can override it. With no explicit date anywhere,
day-name rows stay undated (error) until the user picks a week start.

**Times.** Half-open intervals `[start, end)`: `16:00-20:00` covers 16:00–19:00, not 20:00.
End ≤ start → next day (`22:00-06:00`, `17:30-05:30`). `24:00` = midnight. Zero-length or unparseable → error.

**Tables without an hours column** are whole-day duty: 00:00–24:00 of the row's date.

**Date ranges** (tables whose first column is `מתאריך – עד`): a full range such as
`<day> <dd/mm> <hh:mm> – <day> <dd/mm> <hh:mm>` is read directly. A row with day names only (`<day> עד <day>`)
continues from where the previous row ended (its first day must match) and ends on the named day at the same
handover hour. Doubled ו/י spelling is tolerated. The interpretation is shown as an info note. Anything else
stays `unresolved`.

**Night shifts.** A shift starting 00:00–06:00 and ending by 08:00 belongs to the night between the previous
day and its own day, and is labelled "בין יום X ל־Y" (dates are not moved).

**Assignment kinds.** `timed` or `unresolved`. Search returns only `timed` matches as "on duty" and lists
unresolved ones separately, so "no one" and "can't determine" are never confused.

**Normalization.** Display = source text, whitespace trimmed/collapsed. Matching key additionally unifies
`״`/`"`, `׳`/`'`, en/em dash/`-`. Post names are never merged: `ש"ג` ≠ `שער`.

**Person cells.** `א/ב` = one assignment for each soldier (marked shared); text in `()` is a note, not part of
the name.

**Soldier identity** (`src/core/people.js`). Almost-identical names are one soldier: identical ignoring
spaces/punctuation/`*` and doubled ו/י, or same first name with a last name one letter apart. A short form
(`כהן` vs `אור כהן`) is merged only when exactly one soldier matches; otherwise it is only flagged. Each merge is
listed as an info note; results show the cell's own spelling too.

## By-soldier view and messages

One row per soldier (merged identity), searchable by any spelling. Expanding a soldier shows every assignment
with its source cell, the soldier's warnings, and the personal message. Messages are generated on the server
(`src/core/messages.js`) from that soldier's assignments only — the same text that will later be sent.
Wording (opening / intro / closing, with `{שם}` and `{טווח}`) is editable per session. Time ranges use "עד"
instead of a dash so they read correctly in RTL WhatsApp. Shared shifts say who they are shared with.
The same text feeds the WhatsApp template when sending is configured; otherwise the UI offers copy.

## Weekly board

Rows = the workbook's posts/roles (grouped by table), columns = Sunday–Saturday. Built by `src/core/week.js`,
which runs in the browser on the already-loaded roster and uses the same intervals and post filter
(`src/core/filters.js`) as the search. A shift appears on every day it covers (start < day end and end > day
start), so overnight and multi-day shifts show on each day with "(למחרת)" / "המשך"; a shift ending exactly at
midnight does not spill over. Empty cells from the file show as "ריק בקובץ". Same-soldier overlaps are marked ⚠.
Previous/next week, "this week", "roster week", post filter, and soldier highlight. Clicking a shift shows its
details and source cell; clicking a day opens the hour search on that date.

## Shift search ("חיפוש משמרות")

Day, hour, job and soldier are all optional (`src/core/shifts.js`, served to the browser). Day = shifts touching
that calendar day; hour = active at HH:00 (on that day, or on any roster day); job = the shared post filter;
soldier = any spelling of the soldier, returning all their shifts. Results update live; empty slots from the file
can be included. The day list contains only days that appear in the file.

## Validation display

Checks still run on every upload, but only errors (data that could not be read, so shifts may be missing) are
shown on screen. Warnings and notes are kept in the data, not displayed; overlap ⚠ marks remain on shifts.

## Privacy and retention

- Uploaded file and parsed data live **only in server memory** — never written to disk.
- Each browser gets a random 256-bit token in an `HttpOnly; SameSite=Strict` cookie (`Secure` in production).
  The store is keyed by the token's SHA-256. No roster ids in URLs; search is a POST body.
- Data is deleted after 8h idle / 24h max (configurable), on "מחיקת השיבוץ מהשרת", or on server restart.
- A new upload replaces the previous roster entirely; searches carry a roster version, stale ones get 409.
- Logs never include file contents, names or request bodies.
- All workbook text is rendered with `textContent` (no HTML injection from cells); strict CSP.

## Deployment (Render)

`render.yaml` is a Render Blueprint: Node web service, Frankfurt, `npm ci --omit=dev`, `npm start`,
health check `/api/health`, auto-deploy on every push to `main`, `NODE_ENV=production` (Secure cookies,
trusts one proxy hop for the client IP). On Render: **New → Blueprint → pick this repo → Apply**.

The free plan sleeps after ~15 minutes without traffic; because rosters live only in memory, a sleeping
server forgets uploads (upload again) and the first visit takes ~1 minute to wake. The `starter` plan is
always on — needed once WhatsApp webhooks are connected.

### WhatsApp sending — רשימת הקמה (חד־פעמי)

השליחה כבויה עד שכל המשתנים מוגדרים; האתר עצמו ממשיך לעבוד כרגיל. כל הערכים כאן הם placeholders — הערכים האמיתיים נשמרים רק ב-Render ובמחשב שלך, לא ב-repo.

1. **מסד נתונים (Neon):** ליצור פרויקט ב-Neon, אזור Frankfurt (AWS eu-central-1). להעתיק את מחרוזת החיבור עם `sslmode=verify-full` (מונע אזהרה של pg).
2. **מיגרציה, פעם אחת, לפני השימוש הראשון:**
   ```bash
   DATABASE_URL='<neon url>' npm run migrate
   ```
   אופציונלי: להריץ פעם אחת את בדיקות החוזה מול Neon — `TEST_DATABASE_URL='<neon url>' npm test`.
   זהירות: הבדיקות האלה עושות TRUNCATE לטבלאות. להריץ לפני העלאת אנשי קשר אמיתיים, או מול branch/מסד נפרד.
3. **מפתח הצפנה לטלפונים:**
   ```bash
   node -e "console.log(crypto.randomBytes(32).toString('base64'))"
   ```
   את התוצאה שמים ב-`PHONE_ENC_KEY`. חשוב לגבות אותו — בלעדיו אי אפשר לפענח את המספרים השמורים.
4. **משתני סביבה ב-Render** (Environment): `WA_TOKEN`, `WA_PHONE_NUMBER_ID`, `WA_WABA_ID`, `WA_APP_SECRET`, `WA_VERIFY_TOKEN`, `DATABASE_URL`, `PHONE_ENC_KEY`, `SEND_CODE`, ואופציונלי `WA_TEST_PHONE` (מספר לשליחת בדיקה). `WA_TEMPLATE_NAME` (`duty_roster_week`) ו-`WA_TEMPLATE_LANG` (`he`) כבר מוגדרים ב-`render.yaml`.
   - `WA_APP_SECRET`: בדשבורד של אפליקציית Meta → App settings → Basic → App secret.
   - `WA_VERIFY_TOKEN`: מחרוזת אקראית כלשהי שבוחרים בעצמם — מגדירים את אותה מחרוזת גם ב-Render וגם ב-Meta.
   - `SEND_CODE`: קוד גישה שמקלידים באתר לפני שליחה.
5. **הרצת סקריפט ההקמה** (מהמחשב המקומי, הטוקן לא מודפס):
   ```bash
   WA_TOKEN='<token>' WA_WABA_ID='<WABA ID>' WA_PHONE_NUMBER_ID='<phone number ID>' npm run wa:setup
   ```
   הסקריפט רושם את האפליקציה ל-webhooks של החשבון, ומדפיס את סטטוס התבנית (צריך `APPROVED`), סטטוס ואיכות המספר, ואת כתובת ה-webhook.
6. **Meta → Webhooks:** Callback URL = `https://idf-mission-helper.onrender.com/webhooks/whatsapp`, Verify token = הערך של `WA_VERIFY_TOKEN`, ולהירשם לשדה `messages`.
7. **פרסום האפליקציה:** ב-App settings → Basic להזין Privacy policy URL = `https://idf-mission-helper.onrender.com/privacy.html`, ואז להעביר את האפליקציה למצב Live — בלי זה Meta לא שולחת webhooks אמיתיים.
8. **שליחת בדיקה** (למספר `WA_TEST_PHONE`) מהאתר, לוודא שההודעה והסטטוס מגיעים — ורק אחר כך שליחה אמיתית.

ב-free plan השרת נרדם, ולכן webhooks עלולים ללכת לאיבוד; לשליחה אמיתית מומלץ `starter`.

Public-internet protections: per-IP rate limits (300 API requests/min, 20 uploads/10 min), a cap on
simultaneous sessions (`MAX_SESSIONS`, default 40 — new visitors get "busy" rather than exhausting memory),
`noindex` headers + `robots.txt`, strict CSP, no third-party requests (fonts are self-hosted).
Known audit note: `exceljs` depends on `uuid@8`, flagged for `v3/v5/v6` with a caller buffer; exceljs only
calls `uuid.v4()`, so the advisory does not apply.

## Layout

```
src/core/      pure business logic (no UI)
  workbook.js    ExcelJS → cell grids (only module touching ExcelJS)
  blocks.js      table detection + unparsed regions
  roster.js      dating, intervals, normalized assignments + empty slots
  validate.js    overlaps, duplicates, annotations, similar names, empty slots
  search.js      post options + on-duty search
  filters.js     post/role filter shared by search and board (served to the browser)
  week.js        weekly board (served to the browser)
  shifts.js      flexible shift search (served to the browser)
  people.js      soldier identity (near-identical name merging)
  soldiers.js    roster grouped by soldier
  messages.js    personal message text + template validation
  phones.js      phone normalization
  dates.js       date/time logic (also served to the browser)
  index.js       parseRoster(buffer) pipeline
server/        Express app, in-memory sessions
public/        RTL Hebrew UI, custom date picker
test/          node:test suites; fixtures/build.js generates FICTIONAL workbooks
```
