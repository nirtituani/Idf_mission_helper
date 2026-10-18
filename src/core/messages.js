// Shift wording for personal duty messages (used by the WhatsApp template parameters).
//
// Hebrew text is RTL; WhatsApp renders "16:00–20:00" reversed inside RTL text, so ranges are
// joined with the word "עד" ("16:00 עד 20:00"), which keeps the order correct everywhere.
import { HEBREW_DAYS, addDays, nightBetween, weekdayOf } from './dates.js';

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
