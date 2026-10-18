// Parameters for the approved WhatsApp template, built from one soldier's parsed week.
import { createHash } from 'node:crypto';
import { addDays, weekdayOf } from './dates.js';
import { shiftText } from './messages.js';

export const TEMPLATE_BODY = [
  'שלום {{1}},',
  'אלה השיבוצים שלך לפי קובץ השיבוץ לשבוע {{2}}:',
  'ראשון {{3}}',
  'שני {{4}}',
  'שלישי {{5}}',
  'רביעי {{6}}',
  'חמישי {{7}}',
  'שישי {{8}}',
  'שבת {{9}}',
  'ראשון {{10}}',
  'אם יש טעות בשיבוץ, פנו למפקד. בהצלחה!',
].join('\n');

export const FOOTER = 'הודעה אוטומטית ממערכת השיבוץ';
export const MAX_BODY = 1024;

const dm = (iso) => `${iso.slice(8)}/${iso.slice(5, 7)}`;
const clean = (s) => String(s).replace(/[\r\n\t]+/g, ' ').replace(/ {2,}/g, ' ').trim();

export function buildWaMessage(soldier, assignments, weekStart, { overlapIds = new Set() } = {}) {
  const problems = [];
  const warnings = [];
  const timed = assignments.filter((a) => a.kind === 'timed').sort((x, y) => x.startKey - y.startKey);

  if (soldier.ambiguous) problems.push('התא מכיל יותר משם אחד או הערה — לא ניתן לשייך את ההודעה לחייל אחד.');
  if (assignments.some((a) => a.kind !== 'timed')) problems.push('יש שיבוץ ללא תאריך ושעה מזוהים — לא ניתן לשלוח.');
  if (!timed.length) problems.push('אין שיבוצים עם זמן מזוהה — אין מה לשלוח.');
  if (!weekStart) problems.push('תחילת השבוע לא זוהתה בקובץ — לא ניתן לשלוח.');
  else if (weekdayOf(weekStart) !== 0) problems.push('תחילת השבוע אינה יום ראשון — לא ניתן לשלוח');

  const days = weekStart ? Array.from({ length: 8 }, (_, i) => addDays(weekStart, i)) : [];
  if (weekStart && timed.some((a) => a.start.date < days[0] || a.start.date > days[7])) {
    problems.push('יש שיבוץ מחוץ לטווח השבוע (ראשון עד ראשון) — לא ניתן לשלוח.');
  }
  if (timed.some((a) => overlapIds.has(a.id))) warnings.push('שיבוץ כפול: יש שיבוצים חופפים בזמן.');

  const dayParams = days.map((d) => {
    const shifts = timed.filter((a) => a.start.date === d).map(shiftText);
    return `${dm(d)}: ${shifts.length ? shifts.join(' • ') : '—'}`;
  });
  while (dayParams.length < 8) dayParams.push('—');
  const params = [
    soldier.name,
    weekStart ? `${dm(days[0])} עד ${dm(days[7])}` : '—',
    ...dayParams,
  ].map(clean);

  const body = params.reduce((t, p, i) => t.replaceAll(`{{${i + 1}}}`, () => p), TEMPLATE_BODY);
  if (body.length > MAX_BODY) problems.push(`ההודעה ארוכה מדי (${body.length} תווים, המקסימום ${MAX_BODY}).`);

  return {
    params,
    text: `${body}\n\n${FOOTER}`,
    problems,
    warnings,
    hash: createHash('sha256').update(JSON.stringify(params)).digest('hex'),
    sendable: problems.length === 0,
  };
}

// For a parsed roster: soldier → buildWaMessage result for the roster's selected week, with the
// roster's double bookings (OVERLAP issues) as warnings.
export function rosterMessageBuilder(roster) {
  const byId = new Map(roster.assignments.map((a) => [a.id, a]));
  const overlapIds = new Set(roster.issues.filter((i) => i.code === 'OVERLAP').flatMap((i) => i.assignmentIds));
  const weekStart = roster.weekStart?.date ?? null;
  return (soldier) => buildWaMessage(soldier, soldier.assignmentIds.map((id) => byId.get(id)), weekStart, { overlapIds });
}
