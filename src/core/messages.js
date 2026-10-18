// Personal duty messages, generated only from the soldier's parsed assignments.
//
// Hebrew text is RTL; WhatsApp renders "16:00–20:00" reversed inside RTL text, so ranges are
// joined with the word "עד" ("16:00 עד 20:00"), which keeps the order correct everywhere.
import { HEBREW_DAYS, addDays, nightBetween, weekdayOf } from './dates.js';

export const DEFAULT_TEMPLATE = Object.freeze({
  greeting: 'שלום {שם},',
  intro: 'אלה השיבוצים שלך לפי קובץ השיבוץ ({טווח}):',
  closing: 'בהצלחה!',
});
const FIELDS = Object.keys(DEFAULT_TEMPLATE);
const MAX_FIELD = 300;

export class TemplateError extends Error {}

// Returns a clean template or throws TemplateError. Empty fields are allowed (line omitted).
export function validateTemplate(input) {
  if (!input || typeof input !== 'object') throw new TemplateError('תבנית לא תקינה.');
  const out = {};
  for (const f of FIELDS) {
    const v = input[f] ?? '';
    if (typeof v !== 'string') throw new TemplateError('תבנית לא תקינה.');
    const clean = v.replace(/[\u0000-\u001F\u007F]/g, ' ').trim();
    if (clean.length > MAX_FIELD) throw new TemplateError(`כל שורה בתבנית מוגבלת ל־${MAX_FIELD} תווים.`);
    out[f] = clean;
  }
  return out;
}

const dm = (iso) => `${iso.slice(8)}/${iso.slice(5, 7)}`;
const dayLabel = (iso) => `יום ${HEBREW_DAYS[weekdayOf(iso)]} ${dm(iso)}`;

export function timeLabel(a) {
  if (a.allDay) return 'כל היום';
  const endsAtMidnight = a.end.time === '00:00' && addDays(a.start.date, 1) === a.end.date;
  if (a.end.date === a.start.date || endsAtMidnight) return `${a.start.time} עד ${endsAtMidnight ? '24:00' : a.end.time}`;
  return `${a.start.time} עד ${dayLabel(a.end.date)} ${a.end.time}`;
}

// Everything after the day label: night label (if any), time, place, shared-with.
export function shiftText(a) {
  const place = [a.section, a.position].filter(Boolean).join(' / ');
  const shared = a.sharedWith?.length ? ` (יחד עם ${a.sharedWith.join(', ')})` : '';
  const night = nightBetween(a);
  const nightLabel = night ? `בין יום ${night.fromDay} ${dm(night.fromDate)} ל${night.toDay} ${dm(night.toDate)} · ` : '';
  return `${nightLabel}${timeLabel(a)} · ${place}${shared}`;
}

export function assignmentLine(a) {
  return `• ${nightBetween(a) ? '' : `${dayLabel(a.start.date)} · `}${shiftText(a)}`;
}

// soldier: from groupBySoldier; assignments: that soldier's assignments (any order).
// Returns { text, included, excluded: [{ id, reason }], problems: [string] }.
export function buildMessage(soldier, assignments, template = DEFAULT_TEMPLATE) {
  const timed = assignments.filter((a) => a.kind === 'timed').sort((x, y) => x.startKey - y.startKey);
  const excluded = assignments.filter((a) => a.kind !== 'timed').map((a) => ({ id: a.id, reason: 'לשיבוץ אין תאריך ושעה מזוהים בקובץ' }));
  const problems = [];
  if (soldier.ambiguous) problems.push('התא מכיל יותר משם אחד או הערה — לא ניתן לשייך את ההודעה לחייל אחד.');
  if (!timed.length) problems.push('אין שיבוצים עם זמן מזוהה — אין מה לשלוח.');
  if (excluded.length) problems.push(`${excluded.length} שיבוצים ללא זמן מזוהה לא נכללו בהודעה.`);

  const range = timed.length ? `${dm(timed[0].start.date)} עד ${dm(lastDay(timed))}` : '';
  const fill = (s) => s.replaceAll('{שם}', soldier.name).replaceAll('{טווח}', range);
  const lines = [fill(template.greeting), fill(template.intro), ...timed.map(assignmentLine), fill(template.closing)];
  return {
    text: lines.filter((l) => l !== '').join('\n'),
    included: timed.length,
    excluded,
    problems,
  };
}

// Last calendar day the soldier is on duty (a shift ending exactly at midnight ends the day before).
function lastDay(timed) {
  let last = timed[0].start.date;
  for (const a of timed) {
    const end = a.end.time === '00:00' ? addDays(a.end.date, -1) : a.end.date;
    if (end > last) last = end;
  }
  return last;
}
