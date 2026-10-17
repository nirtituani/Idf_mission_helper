// Calendar dates are 'YYYY-MM-DD' strings; times are minutes from midnight.
// An instant is a "minute key": dayNumber(date) * 1440 + minutes. All arithmetic is in UTC
// day numbers, so the roster's wall-clock times never shift with the server's time zone.
//
// Interval semantics (used everywhere): half-open [start, end).
// A 16:00-20:00 shift covers 16:00, 17:00, 18:00, 19:00 — not 20:00.

export const HEBREW_DAYS = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];
const MINUTES_PER_DAY = 1440;
const MAX_YEARLESS_DISTANCE_DAYS = 183;

export function isIsoDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

export function makeIso(y, m, d) {
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

export function dayNumber(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return Math.floor(Date.UTC(y, m - 1, d) / 86400000);
}

export function fromDayNumber(n) {
  const dt = new Date(n * 86400000);
  return makeIso(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
}

export function addDays(iso, n) {
  return fromDayNumber(dayNumber(iso) + n);
}

export function weekdayOf(iso) {
  return new Date(dayNumber(iso) * 86400000).getUTCDay();
}

export function minuteKey(iso, minutes) {
  return dayNumber(iso) * MINUTES_PER_DAY + minutes;
}

export function keyToParts(key) {
  const day = Math.floor(key / MINUTES_PER_DAY);
  const min = key - day * MINUTES_PER_DAY;
  return { date: fromDayNumber(day), time: formatMinutes(min) };
}

export function formatMinutes(min) {
  return `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
}

// "06:00", "6:00", "24:00" (end of day). Returns minutes or null.
export function parseTimeOfDay(text) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(text.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (min > 59) return null;
  if (h === 24 && min === 0) return MINUTES_PER_DAY;
  if (h > 23) return null;
  return h * 60 + min;
}

// "14:00-22:00", "22:00 – 06:00". End at or before start means the shift ends the next day.
// Returns { startMin, durationMin } or { error }.
export function parseTimeRange(text) {
  const parts = text.split(/\s*[-–—]\s*/);
  if (parts.length !== 2) return { error: 'format' };
  const start = parseTimeOfDay(parts[0]);
  const end = parseTimeOfDay(parts[1]);
  if (start === null || end === null || start === MINUTES_PER_DAY) return { error: 'format' };
  if (end === start) return { error: 'zero-duration' };
  const durationMin = end > start ? end - start : end + MINUTES_PER_DAY - start;
  return { startMin: start, durationMin };
}

// "ראשון", "ראשון 11/10", "יום ראשון 11/10/2026". Returns { weekday, day?, month?, year? } or null.
export function parseDayLabel(text) {
  const m = /^(?:יום\s+)?(\S+?)(?:\s+(\d{1,2})[./](\d{1,2})(?:[./](\d{2,4}))?)?$/.exec(text.trim());
  if (!m) return null;
  const weekday = HEBREW_DAYS.indexOf(m[1]);
  if (weekday < 0) return null;
  const out = { weekday };
  if (m[2]) {
    out.day = Number(m[2]);
    out.month = Number(m[3]);
    if (m[4]) out.year = m[4].length === 2 ? 2000 + Number(m[4]) : Number(m[4]);
  }
  return out;
}

// A day/month without a year: choose the year in which the date falls on the stated weekday and
// lies within ~6 months of the reference date. null if none fits — so a wrong weekday label is an
// error rather than a silent jump of a year.
export function resolveYear({ day, month, weekday, year }, referenceIso) {
  const refYear = Number(referenceIso.slice(0, 4));
  const candidates = year ? [year] : [refYear - 1, refYear, refYear + 1];
  let best = null;
  for (const y of candidates) {
    const iso = makeIso(y, month, day);
    if (!isIsoDate(iso) || weekdayOf(iso) !== weekday) continue;
    const dist = Math.abs(dayNumber(iso) - dayNumber(referenceIso));
    if (!year && dist > MAX_YEARLESS_DISTANCE_DAYS) continue;
    if (!best || dist < best.dist) best = { iso, dist };
  }
  return best ? best.iso : null;
}

// First date >= fromIso with the given weekday.
export function nextWeekdayOnOrAfter(fromIso, weekday) {
  return addDays(fromIso, (weekday - weekdayOf(fromIso) + 7) % 7);
}

export function todayIso(now = new Date()) {
  return makeIso(now.getFullYear(), now.getMonth() + 1, now.getDate());
}

// A shift that starts between 00:00 and 06:00 and ends by 08:00 is a night shift belonging to the
// night between the previous day and its own day: Friday 00:00–04:00 → "בין יום חמישי לשישי".
// x: anything with start {date}, startKey, endKey (assignment, slot, board entry). null otherwise.
export function nightBetween(x) {
  if (!x?.start || x.allDay || x.startKey === null || x.startKey === undefined) return null;
  const dayStart = x.startKey - (x.startKey % MINUTES_PER_DAY);
  if (x.startKey - dayStart >= 6 * 60 || x.endKey - dayStart > 8 * 60) return null;
  const wd = weekdayOf(x.start.date);
  return { fromDay: HEBREW_DAYS[(wd + 6) % 7], toDay: HEBREW_DAYS[wd], fromDate: addDays(x.start.date, -1), toDate: x.start.date };
}
