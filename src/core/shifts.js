// Flexible shift search: any combination of day / hour / post / soldier, each optional.
// Same intervals and post filter as the hour search and the weekly board (served to the browser).
//   day   → shift covers any part of that calendar day (start < day end and end > day start)
//   hour  → shift is active at HH:00 (half-open [start, end)); with no day: on any roster day
//   both  → active at that hour on that day
import { dayNumber, fromDayNumber, minuteKey } from './dates.js';
import { matchesFilter, resolvePostFilter } from './filters.js';

const DAY = 1440;

// Calendar days on which the roster has at least one timed shift or empty slot, ascending.
export function rosterDays(roster) {
  const days = new Set();
  const add = (x) => {
    if (x.startKey === null || x.startKey === undefined) return;
    const last = Math.floor((x.endKey - 1) / DAY);
    for (let d = Math.floor(x.startKey / DAY); d <= last; d++) days.add(d);
  };
  roster.assignments.filter((a) => a.kind === 'timed').forEach(add);
  roster.slots.forEach(add);
  return [...days].sort((a, b) => a - b).map(fromDayNumber);
}

// Returns { shifts, emptySlots } sorted by start, or null if postId is unknown.
export function findShifts(roster, { date = null, hour = null, postId = 'all', soldier = '' } = {}) {
  const filter = resolvePostFilter(roster.options, postId);
  if (!filter) return null;
  const q = soldier.trim();
  const days = date ? [date] : rosterDays(roster);
  const instants = hour === null ? null : days.map((d) => minuteKey(d, hour * 60));
  const d0 = date ? dayNumber(date) * DAY : null;

  const when = (x) => {
    if (x.startKey === null || x.startKey === undefined) return false;
    if (instants) return instants.some((k) => x.startKey <= k && k < x.endKey);
    if (d0 !== null) return x.startKey < d0 + DAY && x.endKey > d0;
    return true;
  };
  const order = (x, y) => x.startKey - y.startKey || (x.id ? Number(x.id.slice(1)) : 0) - (y.id ? Number(y.id.slice(1)) : 0);

  // A soldier matches when any of their spellings matches; then all their shifts count.
  const wanted = q
    ? new Set(roster.assignments.filter((a) => a.person.includes(q) || a.soldier.includes(q)).map((a) => a.personKey))
    : null;
  const shifts = roster.assignments
    .filter((a) => a.kind === 'timed' && when(a) && matchesFilter(filter, a) && (!wanted || wanted.has(a.personKey)))
    .sort(order);
  const emptySlots = q ? [] : roster.slots.filter((s) => when(s) && matchesFilter(filter, s)).sort(order);
  return { shifts, emptySlots };
}
