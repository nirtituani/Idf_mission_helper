// Two tabs = two weeks; second tab with tables side by side and a new standby format.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRoster } from '../src/core/index.js';
import { searchOnDuty } from '../src/core/search.js';
import { buildTwoWeekFixture } from './fixtures/build.js';

const r = await parseRoster(await buildTwoWeekFixture(), { fileName: 'f.xlsx', today: '2026-10-18' });
const one = (name) => {
  const list = r.assignments.filter((a) => a.soldier === name);
  assert.equal(list.length, 1, name);
  return list[0];
};
const when = (a) => `${a.start.date} ${a.start.time} → ${a.end.date} ${a.end.time}`;

test('each tab gets its own week start', () => {
  assert.deepEqual(r.weekStarts.map((w) => [w.sheet, w.date]), [['שבוע 1', '2026-10-11'], ['שבוע 2', '2026-10-18']]);
  assert.equal(when(one('סייר א דמה')), '2026-10-18 22:00 → 2026-10-19 06:00'); // "ראשון" in tab 2 = 18/10, not 11/10
  assert.equal(when(one('ישן דמה')), '2026-10-11 17:30 → 2026-10-12 05:30');
});

test('side-by-side tables: a header in other columns does not cut a table short', () => {
  const statics = r.assignments.filter((a) => a.section === 'סטטיות');
  assert.equal(statics.length, 10); // continues past row 9, where the outpost header sits in B–C
  assert.equal(when(one('שומר י דמה')), '2026-10-20 08:00 → 2026-10-20 12:00');
  assert.equal(when(one('מוצבניק דמה')), '2026-10-18 17:00 → 2026-10-21 17:00'); // the table under patrol is found
});

test('day-range rows ("ראשון - שני") run from the first day to the second', () => {
  assert.equal(when(one('חדש א דמה')), '2026-10-18 17:30 → 2026-10-19 20:00');
  assert.equal(when(one('חדש ב דמה')), '2026-10-19 20:00 → 2026-10-20 20:00'); // "20:00 - 20:00" = 24h
  assert.equal(r.summary.issues.error, 0); // the trailing "20:00 - 20:00" row without names is not an error
});

test('newer tab wins where both tabs cover the same post at the same time', () => {
  assert.equal(r.assignments.filter((a) => a.soldier === 'ישן ג דמה').length, 0); // old Sunday standby replaced
  assert.equal(r.assignments.filter((a) => a.soldier === 'מוחלף דמה').length, 0); // old Sunday kitchen replaced
  assert.equal(one('קודם דמה').start.date, '2026-10-11'); // older days of the old tab are kept
  const notes = r.issues.filter((i) => i.code === 'SUPERSEDED');
  assert.equal(notes.length, 2);
  const standby = r.options.find((g) => g.label === 'כיתת כוננות').id;
  const res = searchOnDuty(r, r.options, { date: '2026-10-18', hour: 21, postId: standby });
  assert.deepEqual(res.matches.map((a) => a.person), ['חדש א דמה']);
});

test('a single-tab file still uses one week start and the user override', async () => {
  const { buildMainFixture } = await import('./fixtures/build.js');
  const single = await parseRoster(await buildMainFixture(), { fileName: 'f.xlsx', today: '2026-10-17', weekStartOverride: '2026-10-04' });
  assert.equal(single.weekStarts.length, 1);
  assert.equal(single.weekStart.source, 'user');
});
