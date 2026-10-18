import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRoster } from '../src/core/index.js';
import { findShifts, rosterDays } from '../src/core/shifts.js';
import { buildMainFixture } from './fixtures/build.js';

const roster = await parseRoster(await buildMainFixture(), { fileName: 'f.xlsx', today: '2026-10-17' });
const optionId = (section, position) => {
  const g = roster.options.find((x) => x.label === section);
  return position ? g.positions.find((p) => p.label === position).id : g.id;
};
const people = (res) => res.shifts.map((a) => a.person);
const timedCount = roster.assignments.filter((a) => a.kind === 'timed').length;

test('roster days = every day covered by a shift (multi-day ranges included)', () => {
  assert.deepEqual(rosterDays(roster), ['2026-10-11', '2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16', '2026-10-17', '2026-10-18']);
});

test('no filters → every timed shift, time-ordered', () => {
  const res = findShifts(roster);
  assert.equal(res.shifts.length, timedCount);
  const starts = res.shifts.map((a) => a.startKey);
  assert.deepEqual(starts, [...starts].sort((a, b) => a - b));
});

test('job only → all shifts of that post across the week', () => {
  const res = findShifts(roster, { postId: optionId('סטטיות', 'מזרחית') });
  assert.deepEqual(people(res), ['יעל דמה', 'מור דמה', 'מחלקה 2', 'נוי דמה', 'עדי דמה', 'פז דמה']);
  assert.ok(res.shifts.every((a) => a.position === 'מזרחית'));
});

test('day only → shifts touching that day, including overnight from the day before', () => {
  const res = findShifts(roster, { date: '2026-10-12', postId: optionId('סיור', 'מפקד – סיור') });
  assert.deepEqual(people(res), ['אבי דמה', 'גדי דמה', 'הדר דמה', 'זיו דמה']);
});

test('a shift ending exactly at midnight does not count for the next day', () => {
  const res = findShifts(roster, { date: '2026-10-12', postId: optionId('סטטיות', 'ש״ג') });
  assert.ok(!people(res).includes('כרם דמה'));
});

test('hour only → active at that hour on any day', () => {
  const res = findShifts(roster, { hour: 23, postId: optionId('סיור') });
  assert.deepEqual(people(res), ['אבי דמה', 'בני דמה', 'זיו דמה', 'חן דמה']);
});

test('day + hour + job = the same answer as the hour search', () => {
  const res = findShifts(roster, { date: '2026-10-12', hour: 17, postId: optionId('סטטיות', 'מזרחית') });
  assert.deepEqual(people(res), ['עדי דמה', 'פז דמה']);
});

test('soldier filter matches merged name and any source spelling', () => {
  assert.deepEqual(people(findShifts(roster, { soldier: 'נוה' })), ['נווה דמה', 'נווה דמה']);
  assert.deepEqual(people(findShifts(roster, { soldier: 'שי דמה' })), ['שי דמה']);
});

test('empty slots are returned separately and respect the filters', () => {
  const res = findShifts(roster, { date: '2026-10-11', postId: optionId('סיור', 'מפקד – סיור') });
  assert.equal(res.emptySlots.length, 1);
  assert.equal(res.emptySlots[0].start.time, '14:00');
  assert.deepEqual(findShifts(roster, { soldier: 'אבי' }).emptySlots, []);
});

test('nothing matching → empty, never invented; unknown post → null', () => {
  assert.deepEqual(findShifts(roster, { date: '2026-10-25' }).shifts, []);
  assert.equal(findShifts(roster, { postId: 'g99' }), null);
});
