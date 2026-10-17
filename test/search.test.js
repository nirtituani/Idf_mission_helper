import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRoster } from '../src/core/index.js';
import { searchOnDuty, SearchError } from '../src/core/search.js';
import { buildMainFixture } from './fixtures/build.js';

const roster = await parseRoster(await buildMainFixture(), { fileName: 'f.xlsx', today: '2026-10-17' });
const optionId = (section, position) => {
  const g = roster.options.find((x) => x.label === section);
  return position ? g.positions.find((p) => p.label === position).id : g.id;
};
const run = (date, hour, postId = 'all') => searchOnDuty(roster, roster.options, { date, hour, postId });
const names = (res) => res.matches.map((a) => a.soldier);

test('half-open interval: 16:00-20:00 covers 16:00 and 19:00, not 20:00', () => {
  const post = optionId('סטטיות', 'ש״ג');
  assert.deepEqual(names(run('2026-10-11', 16, post)), ['טל דמה']);
  assert.deepEqual(names(run('2026-10-11', 19, post)), ['טל דמה']);
  assert.deepEqual(names(run('2026-10-11', 20, post)), ['כרם דמה']);
  assert.deepEqual(names(run('2026-10-11', 15, post)), []);
});

test('overnight shift is found on the next calendar day', () => {
  const post = optionId('סיור');
  assert.deepEqual(names(run('2026-10-11', 23, post)), ['אבי דמה', 'בני דמה']);
  assert.deepEqual(names(run('2026-10-12', 5, post)), ['אבי דמה', 'בני דמה']);
  assert.deepEqual(names(run('2026-10-12', 6, post)), ['גדי דמה', 'דני דמה']);
});

test('20:00-24:00 ends at midnight; 00:00 belongs to the next row', () => {
  const post = optionId('סטטיות', 'ש״ג');
  assert.deepEqual(names(run('2026-10-11', 23, post)), ['כרם דמה']);
  assert.deepEqual(names(run('2026-10-12', 0, post)), ['לוטם דמה']);
});

test('multiple soldiers at the same post/time are all returned', () => {
  const res = run('2026-10-12', 17, optionId('סטטיות', 'מזרחית'));
  assert.deepEqual(names(res), ['עדי דמה', 'פז דמה']);
});

test('a soldier with overlapping assignments appears in each matching post', () => {
  const res = run('2026-10-12', 9);
  assert.equal(names(res).filter((n) => n === 'גדי דמה').length, 2);
});

test('post filter restricts results to that post only', () => {
  const res = run('2026-10-12', 9, optionId('סטטיות', 'מזרחית'));
  assert.deepEqual(res.matches.map((a) => [a.section, a.position, a.soldier]), [['סטטיות', 'מזרחית', 'נוי דמה']]);
});

test('post in workbook but no one at that hour → none (no invented soldier), empty slot surfaced', () => {
  const res = run('2026-10-11', 21, optionId('סטטיות', 'מזרחית'));
  assert.equal(res.status, 'none');
  assert.deepEqual(res.matches, []);
  assert.equal(res.emptySlots.length, 1);
  assert.equal(res.emptySlots[0].position, 'מזרחית');
});

test('date outside the roster → outside-range, no results', () => {
  const res = run('2026-11-01', 10);
  assert.equal(res.status, 'outside-range');
  assert.deepEqual(res.matches, []);
});

test('kitchen (whole day) matches every hour of its date, not the next day', () => {
  const kitchen = optionId('מטבח', 'מטבח 1 (עיבוי ש"ג)');
  for (const h of [0, 10, 23]) assert.deepEqual(names(run('2026-10-11', h, kitchen)), ['קרן דמה']);
  assert.deepEqual(names(run('2026-10-12', 0, kitchen)), ['רון דמה', 'שי דמה']);
});

test('continued range is searchable; unresolved ones are listed as undetermined, never on-duty', () => {
  const outpost = run('2026-10-15', 10, optionId('מוצב'));
  assert.deepEqual(names(outpost), ['אלון דמה']);
  assert.deepEqual(names(run('2026-10-18', 11, optionId('מוצב'))), []);
  assert.deepEqual(outpost.undetermined.map((a) => a.soldier), ['עומר דמה']);
});

test('every whole hour 0..23 is accepted; others rejected', () => {
  for (let h = 0; h < 24; h++) assert.doesNotThrow(() => run('2026-10-12', h));
  for (const bad of [24, -1, 1.5, '10']) assert.throws(() => run('2026-10-12', bad), SearchError);
  assert.throws(() => run('2026-02-30', 10), SearchError);
});

test('unknown post id (e.g. from a previous upload) is rejected', () => {
  assert.throws(() => run('2026-10-12', 10, 'g99p0'), SearchError);
});
