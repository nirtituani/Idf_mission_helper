// Weekly duty board: rows = posts/roles (from the workbook), columns = 7 days (Sunday first).
// Uses the same assignments, empty slots, half-open intervals and post filter as the search.
// A shift appears on every calendar day it covers: an assignment covers day D when
// start < D+24h and end > D 00:00 — so a shift ending exactly at midnight does not spill over.
import { HEBREW_DAYS, addDays, minuteKey, weekdayOf } from './dates.js';
import { matchesFilter, resolvePostFilter } from './filters.js';

const DAY = 1440;

export const weekStartOf = (iso) => addDays(iso, -weekdayOf(iso));

// Returns { weekStart, days, sections: [{ label, rows: [{ label, cells: Entry[7][] }] }],
//           hiddenRows, assignmentCount, undetermined } or null if postId is unknown.
// assignmentCount counts each shift once, even when it spans several days.
// Entry = { type: 'assignment' | 'empty', id?, cell?, person?, soldier?, startKey, endKey,
//           start, end, allDay, startsToday, endsToday }
export function buildWeekBoard(roster, weekStart, postId = 'all') {
  const filter = resolvePostFilter(roster.options, postId);
  if (!filter) return null;
  const days = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
  const dayStarts = days.map((d) => minuteKey(d, 0));

  const rowsByKey = new Map();
  const sections = [];
  for (const g of roster.options) {
    const section = { label: g.label, rows: [] };
    for (const p of g.positions) {
      const row = { label: p.label, sectionKey: g.sectionKey, positionKey: p.positionKey, cells: days.map(() => []) };
      if (!matchesFilter(filter, row)) continue;
      rowsByKey.set(`${g.sectionKey}|${p.positionKey}`, row);
      section.rows.push(row);
    }
    if (section.rows.length) sections.push(section);
  }

  const place = (item, entry) => {
    const row = rowsByKey.get(`${item.sectionKey}|${item.positionKey}`);
    if (!row) return 0;
    let placed = 0;
    dayStarts.forEach((d0, i) => {
      if (item.startKey < d0 + DAY && item.endKey > d0) {
        row.cells[i].push({ ...entry, startsToday: item.startKey >= d0, endsToday: item.endKey <= d0 + DAY });
        placed++;
      }
    });
    return placed;
  };

  let assignmentCount = 0;
  for (const a of roster.assignments) {
    if (a.kind !== 'timed') continue;
    const placed = place(a, {
      type: 'assignment',
      id: a.id,
      person: a.person,
      personKey: a.personKey,
      soldier: a.soldier,
      startKey: a.startKey,
      endKey: a.endKey,
      start: a.start,
      end: a.end,
      allDay: a.allDay,
      order: Number(a.id.slice(1)),
    });
    if (placed) assignmentCount++;
  }
  for (const s of roster.slots) {
    if (s.startKey === null) continue;
    place(s, { type: 'empty', cell: s.cell, startKey: s.startKey, endKey: s.endKey, start: s.start, end: s.end, allDay: s.allDay, order: Infinity });
  }

  let hiddenRows = 0;
  for (const section of sections) {
    for (const row of section.rows) for (const cell of row.cells) cell.sort((x, y) => x.startKey - y.startKey || x.order - y.order);
    const before = section.rows.length;
    section.rows = section.rows.filter((r) => r.cells.some((c) => c.length));
    hiddenRows += before - section.rows.length;
  }

  return {
    weekStart,
    days,
    sections: sections.filter((s) => s.rows.length),
    hiddenRows,
    assignmentCount,
    undetermined: roster.assignments.filter((a) => a.kind === 'unresolved' && matchesFilter(filter, a)),
  };
}

const dm = (iso) => `${iso.slice(8)}/${iso.slice(5, 7)}`;

// Text for an entry inside one day's cell. Ranges use "עד" (reads correctly in RTL).
export function entryTimeLabel(e) {
  if (e.allDay) return 'כל היום';
  const endText = e.end.time === '00:00' ? '24:00' : e.end.time;
  if (e.startsToday && e.endsToday) return `${e.start.time} עד ${endText}`;
  if (e.startsToday) {
    const nextDay = addDays(e.start.date, 1) === e.end.date;
    return nextDay ? `${e.start.time} עד ${e.end.time} (למחרת)` : `${e.start.time} עד ${HEBREW_DAYS[weekdayOf(e.end.date)]} ${dm(e.end.date)} ${e.end.time}`;
  }
  if (e.endsToday) return `המשך, עד ${endText}`;
  return 'כל היום (המשך)';
}
