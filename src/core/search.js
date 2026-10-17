// "Who is on duty at <date> <hour> at <post>?" — answered strictly from the parsed roster.
import { isIsoDate, minuteKey } from './dates.js';
import { matchesFilter as matches, resolvePostFilter } from './filters.js';

export { resolvePostFilter };

// Post/role options, built only from the uploaded workbook's sections and positions.
// Ids are scoped to one parsed roster (`rosterVersion`) so stale options can't be reused.
export function buildPostOptions(sections) {
  return sections
    .filter((s) => s.positions.length)
    .map((s, gi) => ({
      id: `g${gi}`,
      label: s.label,
      sectionKey: s.key,
      positions: s.positions.map((p, pi) => ({ id: `g${gi}p${pi}`, label: p.label, positionKey: p.key })),
    }));
}

export function rosterDateRange(roster) {
  const dates = [];
  for (const a of roster.assignments) {
    if (a.kind === 'timed') dates.push(a.start.date, a.endKey % 1440 === 0 ? prevDate(a.end.date) : a.end.date);
  }
  for (const s of roster.slots) if (s.date) dates.push(s.date);
  if (!dates.length) return null;
  dates.sort();
  return { from: dates[0], to: dates[dates.length - 1] };
}

function prevDate(iso) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

// Returns { status, matches, emptySlots, undetermined }
//   status: 'found' | 'none' | 'outside-range'
// `undetermined` lists matching-post assignments whose time could not be established, so the
// caller can say "unable to determine" instead of a plain "no one".
export function searchOnDuty(roster, options, { date, hour, postId }) {
  if (!isIsoDate(date)) throw new SearchError('תאריך לא תקין');
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) throw new SearchError('שעה לא תקינה');
  const filter = resolvePostFilter(options, postId);
  if (!filter) throw new SearchError('העמדה שנבחרה אינה קיימת בקובץ הנוכחי');

  const key = minuteKey(date, hour * 60);
  const covers = (x) => x.startKey <= key && key < x.endKey;
  const range = rosterDateRange(roster);
  const inRange = Boolean(range) && date >= range.from && date <= range.to;

  // Same start → keep workbook order (assignment ids / slot cells are created in document order).
  const docOrder = (x) => Number((x.id || '').slice(1)) || 0;
  const sortByStart = (x, y) => x.startKey - y.startKey || docOrder(x) - docOrder(y) || (x.cell ?? '').localeCompare(y.cell ?? '');
  const found = roster.assignments.filter((a) => a.kind === 'timed' && matches(filter, a) && covers(a)).sort(sortByStart);
  const emptySlots = roster.slots.filter((s) => s.startKey !== null && matches(filter, s) && covers(s)).sort(sortByStart);
  const undetermined = roster.assignments.filter((a) => a.kind === 'unresolved' && matches(filter, a));

  return {
    query: { date, hour, postId: postId ?? 'all', postLabel: filter.label },
    status: found.length ? 'found' : inRange ? 'none' : 'outside-range',
    range,
    matches: found,
    emptySlots,
    undetermined,
  };
}

export class SearchError extends Error {}
