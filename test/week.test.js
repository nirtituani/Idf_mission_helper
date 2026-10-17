import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRoster } from '../src/core/index.js';
import { buildWeekBoard, entryTimeLabel, weekStartOf } from '../src/core/week.js';
import { buildMainFixture } from './fixtures/build.js';

const roster = await parseRoster(await buildMainFixture(), { fileName: 'f.xlsx', today: '2026-10-17' });
const WEEK = '2026-10-11';
const optionId = (section, position) => {
  const g = roster.options.find((x) => x.label === section);
  return position ? g.positions.find((p) => p.label === position).id : g.id;
};
const row = (board, section, position) => board.sections.find((s) => s.label === section)?.rows.find((r) => r.label === position);
const day = (r, iso, board) => r.cells[board.days.indexOf(iso)];
const people = (cell) => cell.filter((e) => e.type === 'assignment').map((e) => e.person);

test('week starts on Sunday; 7 consecutive days', () => {
  assert.equal(weekStartOf('2026-10-17'), '2026-10-11');
  assert.equal(weekStartOf('2026-10-11'), '2026-10-11');
  const b = buildWeekBoard(roster, WEEK);
  assert.deepEqual(b.days, ['2026-10-11', '2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16', '2026-10-17']);
});

test('rows are exactly the workbook posts/roles that have entries this week', () => {
  const b = buildWeekBoard(roster, WEEK);
  assert.deepEqual(b.sections.map((s) => [s.label, s.rows.map((r) => r.label)]), [
    ['סיור', ['מפקד – סיור', 'לוחם – סיור']],
    ['סטטיות', ['ש״ג', 'מזרחית']],
    ['מטבח', ['מטבח 1 (עיבוי ש"ג)', 'מטבח 2']],
    ['מוצב', ['מפקד', 'לוחם 1']],
    ['חמ"ל', ['חמליסט', 'רץ חמ"ל']],
  ]);
});

test('overnight shift appears on both days with start/continuation flags', () => {
  const b = buildWeekBoard(roster, WEEK);
  const r = row(b, 'סיור', 'מפקד – סיור');
  const sun = day(r, '2026-10-11', b).find((e) => e.person === 'אבי דמה');
  const mon = day(r, '2026-10-12', b).find((e) => e.person === 'אבי דמה');
  assert.deepEqual([sun.startsToday, sun.endsToday, mon.startsToday, mon.endsToday], [true, false, false, true]);
  assert.equal(entryTimeLabel(sun), '22:00 עד 06:00 (למחרת)');
  assert.equal(entryTimeLabel(mon), 'המשך, עד 06:00');
});

test('shifts ending exactly at midnight do not spill into the next day', () => {
  const b = buildWeekBoard(roster, WEEK);
  const gate = row(b, 'סטטיות', 'ש״ג');
  const sun = day(gate, '2026-10-11', b).find((e) => e.person === 'כרם דמה');
  assert.equal(entryTimeLabel(sun), '20:00 עד 24:00');
  assert.ok(!people(day(gate, '2026-10-12', b)).includes('כרם דמה'));
  const kitchen = row(b, 'מטבח', 'מטבח 1 (עיבוי ש"ג)');
  assert.deepEqual(people(day(kitchen, '2026-10-11', b)), ['קרן דמה']);
  assert.equal(entryTimeLabel(day(kitchen, '2026-10-11', b)[0]), 'כל היום');
  assert.ok(!people(day(kitchen, '2026-10-12', b)).includes('קרן דמה'));
});

test('multi-day range appears on every covered day', () => {
  const b = buildWeekBoard(roster, WEEK);
  const cmd = row(b, 'מוצב', 'מפקד');
  const daysWithAlon = b.days.filter((d) => people(day(cmd, d, b)).includes('אלון דמה'));
  assert.deepEqual(daysWithAlon, ['2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16', '2026-10-17']);
  const labels = daysWithAlon.map((d) => entryTimeLabel(day(cmd, d, b).find((e) => e.person === 'אלון דמה')));
  assert.equal(labels[0], '11:00 עד ראשון 18/10 11:00');
  assert.equal(labels[1], 'כל היום (המשך)');
  // continues into next week and ends there
  const next = buildWeekBoard(roster, '2026-10-18');
  const e = day(row(next, 'מוצב', 'מפקד'), '2026-10-18', next).find((x) => x.person === 'אלון דמה');
  assert.equal(entryTimeLabel(e), 'המשך, עד 11:00');
});

test('post filter limits rows; same semantics as the search', () => {
  const b = buildWeekBoard(roster, WEEK, optionId('סטטיות', 'מזרחית'));
  assert.deepEqual(b.sections.map((s) => [s.label, s.rows.map((r) => r.label)]), [['סטטיות', ['מזרחית']]]);
  assert.deepEqual(people(day(b.sections[0].rows[0], '2026-10-12', b)), ['מור דמה', 'נוי דמה', 'עדי דמה', 'פז דמה']);
  assert.equal(buildWeekBoard(roster, WEEK, 'g99'), null);
});

test('empty slots from the file are shown as empty, not filled', () => {
  const b = buildWeekBoard(roster, WEEK);
  const sunPatrol = day(row(b, 'סיור', 'מפקד – סיור'), '2026-10-11', b);
  assert.equal(sunPatrol[0].type, 'empty');
  assert.equal(entryTimeLabel(sunPatrol[0]), '14:00 עד 22:00');
});

test('a week outside the roster has no entries and no rows', () => {
  const b = buildWeekBoard(roster, '2026-11-01');
  assert.equal(b.assignmentCount, 0);
  assert.deepEqual(b.sections, []);
});

test('assignmentCount counts multi-day shifts once', () => {
  const b = buildWeekBoard(roster, WEEK, optionId('סיור', 'מפקד – סיור'));
  const ids = new Set(b.sections[0].rows[0].cells.flat().filter((e) => e.id).map((e) => e.id));
  assert.equal(b.assignmentCount, ids.size);
  assert.ok(b.sections[0].rows[0].cells.flat().filter((e) => e.id).length > ids.size); // overnight shift on 2 days
});

test('every timed assignment appears on at least one day of some week', () => {
  const ids = new Set();
  for (const ws of ['2026-10-11', '2026-10-18']) {
    for (const s of buildWeekBoard(roster, ws).sections) for (const r of s.rows) for (const c of r.cells) for (const e of c) if (e.id) ids.add(e.id);
  }
  assert.equal(ids.size, roster.assignments.filter((a) => a.kind === 'timed').length);
});
