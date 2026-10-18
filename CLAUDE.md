# Duty roster app — notes for Claude

Hebrew RTL web app: upload a weekly duty-roster Excel → validate, search who is on duty, weekly board,
per-soldier roster + WhatsApp message text. The Excel file is the single source of truth: never invent,
guess or fill in data; anything that can't be read is reported, not assumed.

## ⚠️ This repo is PUBLIC
Never commit real soldier names, real roster files (`*.xlsx` is gitignored), outpost/base names, real
dates or phone numbers — not in code, tests, comments, README or commit messages. Test fixtures in
`test/fixtures/build.js` are fictional ("… דמה") and must stay that way. Real rosters live only on the
user's machine.

## Run
- `npm install`, `npm test` (node:test + supertest + jsdom; all tests must pass before pushing)
- `PORT=3100 npm start` locally (port 3000 may be taken)
- Live: https://idf-mission-helper.onrender.com — Render Blueprint `render.yaml`, free plan,
  auto-deploys on every push to `main`. Verify live changes only with fictional files.
- Git: `main` = current "operations board" design; tag `design-v1` = original design.

## Layout
- `src/core/` — parsing and logic (pure, tested): `workbook` (ExcelJS → grids), `blocks` (find tables),
  `roster` (build assignments), `validate`, `people` (name identity), `soldiers`, `messages`,
  `search`, `shifts`, `week`, `dates`, `filters`, `text`. `index.js` → `parseRoster()`.
- `server/` — Express app; sessions in memory only (HttpOnly cookie, 8h idle / 24h max, cap 40),
  rate limits, CSP. Rosters never touch disk.
- `public/` — vanilla JS UI, self-hosted fonts. Some core modules are served to the browser via an
  allowlist in `server/app.js` (dates, filters, week, shifts).

## Roster rules (decided with the user — apply to every upload)
- Tables are found by structure (a "יום" or "מתאריך – עד" header; title = cell above). Must work for
  any roster in this format, not one specific file. Side-by-side tables are supported.
- Times are half-open [start, end); end ≤ start = overnight; 24:00 = midnight.
- Kitchen / tables without an hours column = whole-day duty (00:00–24:00). Kitchen + another duty
  the same day IS a real overlap.
- Names without a task are ignored.
- Day-range label "ראשון - שני" with "17:30-20:00" = from 17:30 on the first day to 20:00 on the
  second ("20:00 - 20:00" = 24h).
- A row with day names only ("שלישי עד ראשון") continues from the previous row's end and ends on the
  named day at the same hour.
- Week start is per tab (Sunday on/before the earliest explicit date in the tab). Multi-tab files:
  the newer tab wins where the same post/time overlaps. The user usually uploads only the current tab.
- Cell "א/ב" = shift for both soldiers; "(…)" = note.
- Near-identical spellings are the same soldier (punctuation/spaces/`*`, doubled ו/י, one-letter or
  swapped-letter difference in the last name with the same first name); a short form merges only if it
  matches exactly one soldier.
- "מחלקה N" / "פלוגה" / "צוות" = a unit, not a soldier: shown in search and board, excluded from the
  soldier list/count, never messaged, never an overlap.
- Shifts starting 00:00–06:00 (ending ≤ 08:00) get the label "בין יום X ל־Y" (night between the
  previous day and this day). Dates are NOT shifted.
- Ignore the availability list (א.ב.ג.ד…) next to names.
- On screen, show only "בעיות בשיבוץ": read errors + a soldier's double bookings. Name merges, notes
  and similar info are not shown.
- In Hebrew text, write time ranges with "עד" (not a dash — RTL bidi flips it); in HTML wrap times in
  `<bdi dir="ltr">`.

## Next: WhatsApp sending (not built yet)
Meta WhatsApp Cloud API with the user's new dedicated number (it must not be registered in the
WhatsApp app). Plan: contacts Excel upload (name + phone) matched to soldiers; approved message
template (template parameters can't contain newlines); test mode; preview → confirm → send with
per-soldier status and no duplicate sends; webhooks for delivery status; an access code before
sending is enabled on the public site; secrets only in server env vars, never in the browser or repo.
Webhooks need an always-on server → Render Starter plan ($7/month) — ask the user before changing it.
~70 soldiers, weekly.

## Working with the user
Explain in simple terms; ask before costs or anything outward-facing; report honestly what was tested.
