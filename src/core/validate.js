// Roster quality checks. Reports only — never modifies assignments.
// Coverage is not assumed: an empty cell in a row that has a day and hours is reported as an
// empty slot because the workbook itself defines that slot; nothing else is treated as a gap.
import { hasNameAnnotation } from './text.js';
import { identifySoldiers, isUnitName } from './people.js';

export function validateRoster(roster) {
  const { assignments, slots } = roster;
  const issues = roster.issues;
  const add = (level, code, message, cells = [], assignmentIds = []) => {
    issues.push({ id: `i${issues.length + 1}`, level, code, message, cells, assignmentIds });
  };
  const cellOf = (a) => `${a.source.sheet}!${a.source.cell}`;
  const timed = assignments.filter((a) => a.kind === 'timed');
  const { merges, related } = identifySoldiers(assignments);

  // Overlapping assignments for the same soldier (after merging near-identical names).
  // A unit ("מחלקה 2") may cover several posts at once — that is not a double booking.
  const bySoldier = groupBy(timed.filter((a) => !isUnitName(a.person)), (a) => a.personKey);
  for (const list of bySoldier.values()) {
    list.sort((x, y) => x.startKey - y.startKey);
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length && list[j].startKey < list[i].endKey; j++) {
        const [a, b] = [list[i], list[j]];
        const same = a.startKey === b.startKey && a.endKey === b.endKey && a.sectionKey === b.sectionKey && a.positionKey === b.positionKey;
        add(
          'warning',
          same ? 'DUPLICATE' : 'OVERLAP',
          same
            ? `"${a.person}" משובץ פעמיים לאותה עמדה ובאותן שעות.`
            : `"${a.person}" משובץ בשני שיבוצים חופפים: ${describe(a)} ו־${describe(b)}.`,
          [cellOf(a), cellOf(b)],
          [a.id, b.id],
        );
      }
    }
  }

  // Cells that look like more than one plain name.
  for (const a of assignments) {
    if (hasNameAnnotation(a.soldier) && !isUnitName(a.soldier)) {
      add('info', 'NAME_ANNOTATION', `בתא "${a.soldier}" יש סימון נוסף לשם (למשל *). הערך מוצג כפי שהוא.`, [cellOf(a)], [a.id]);
    }
  }

  // Near-identical spellings merged into one soldier — listed so the merge can be checked.
  for (const m of merges) {
    const ids = assignments.filter((a) => a.person === m.person).map((a) => a.id);
    const spelled = m.variants.map((v) => `"${v.name}" (${v.count})`).join(', ');
    add('info', 'NAMES_MERGED', `אוחדו כחייל אחד "${m.person}": ${spelled}.`, [], ids);
  }

  // Possibly the same soldier but not almost identical — reported, not merged.
  for (const [x, y] of related) {
    const ids = assignments.filter((a) => a.person === x || a.person === y).map((a) => a.id);
    add('warning', 'SIMILAR_NAMES', `"${x}" ו־"${y}" דומים — ייתכן שזה אותו חייל, אך השמות אינם כמעט זהים ולכן לא אוחדו.`, [], ids);
  }

  // Empty slots, aggregated per section/position.
  const emptyGroups = groupBy(slots, (s) => `${s.sectionKey}|${s.positionKey}`);
  for (const list of emptyGroups.values()) {
    const { section, position } = list[0];
    add('info', 'EMPTY_SLOT', `${list.length} משבצות ריקות ב"${section ?? 'ללא כותרת'}" / "${position ?? '—'}".`, list.map((s) => s.cell));
  }

  // Link issues to assignments by the cells they reference (row-level time/day errors).
  const byCell = new Map();
  for (const a of assignments) {
    for (const c of [a.source.cell, a.source.time, a.source.day]) {
      if (!c) continue;
      const k = `${a.source.sheet}!${c}`;
      if (!byCell.has(k)) byCell.set(k, []);
      byCell.get(k).push(a.id);
    }
  }
  for (const issue of issues) {
    if (['EMPTY_SLOT', 'UNPARSED_REGION', 'NAMES_MERGED', 'SIMILAR_NAMES'].includes(issue.code)) continue;
    const linked = new Set(issue.assignmentIds);
    for (const c of issue.cells) for (const id of byCell.get(c) || []) linked.add(id);
    issue.assignmentIds = [...linked];
  }

  // Any unresolved assignment not explained by an issue gets one generic notice.
  const explained = new Set(issues.flatMap((i) => i.assignmentIds));
  const unexplained = assignments.filter((a) => a.kind === 'unresolved' && !explained.has(a.id));
  if (unexplained.length) {
    add('warning', 'UNRESOLVED_ASSIGNMENT', `${unexplained.length} שיבוצים ללא תאריך או שעה אמינים — לא ייכללו בחיפוש לפי שעה.`, unexplained.map(cellOf), unexplained.map((a) => a.id));
  }

  return roster;
}

function describe(a) {
  const dm = (iso) => `${iso.slice(8)}/${iso.slice(5, 7)}`;
  const when = a.allDay
    ? `${dm(a.start.date)} כל היום`
    : a.start.date === a.end.date
      ? `${dm(a.start.date)} ${a.start.time} עד ${a.end.time}`
      : `${dm(a.start.date)} ${a.start.time} עד ${dm(a.end.date)} ${a.end.time}`;
  return `${a.section ?? ''} / ${a.position ?? ''} (${when})`;
}

function groupBy(list, keyFn) {
  const m = new Map();
  for (const x of list) {
    const k = keyFn(x);
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(x);
  }
  return m;
}

