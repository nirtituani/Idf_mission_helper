// Two tabs = two weeks: only the newest week's tab is used. The second tab has tables side by side
// and a new standby format.
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

test('only the newest week tab is read; older tabs are listed as ignored', () => {
  assert.equal(r.usedSheet, 'שבוע 2');
  assert.deepEqual(r.weekStarts.map((w) => [w.sheet, w.date]), [['שבוע 2', '2026-10-18']]);
  assert.deepEqual(r.sheets.map((x) => [x.name, x.ignored]), [['שבוע 1', true], ['שבוע 2', false]]);
  assert.equal(when(one('סייר א דמה')), '2026-10-18 22:00 → 2026-10-19 06:00');
  for (const old of ['ישן דמה', 'קודם דמה', 'ישן ג דמה', 'מוחלף דמה']) assert.equal(r.assignments.filter((a) => a.soldier === old).length, 0, old);
  assert.ok(r.assignments.every((a) => a.sheet === 'שבוע 2'));
  assert.equal(r.issues.filter((i) => i.code === 'SUPERSEDED').length, 0);
});

// tabs: [name, day label or null] — each tab one patrol row with soldier "<name> דמה".
async function tabs(list) {
  const ExcelJS = (await import('exceljs')).default;
  const wb = new ExcelJS.Workbook();
  for (const [name, day] of list) {
    const ws = wb.addWorksheet(name);
    ws.getCell('A1').value = 'סיור';
    ['יום', 'שעות', 'לוחם'].forEach((h, i) => (ws.getCell(2, i + 1).value = h));
    ws.getCell('A3').value = day ?? 'ראשון';
    ws.getCell('B3').value = '08:00-12:00';
    ws.getCell('C3').value = `${name} דמה`;
  }
  return parseRoster(Buffer.from(await wb.xlsx.writeBuffer()), { fileName: 'f.xlsx', today: '2026-10-18' });
}

test('the newest week wins by date, not by tab order', async () => {
  const t = await tabs([['חדש', 'ראשון 18/10'], ['ישן', 'ראשון 11/10']]);
  assert.equal(t.usedSheet, 'חדש');
  assert.deepEqual(t.assignments.map((a) => a.soldier), ['חדש דמה']);
});

test('a tab without dates is skipped when another tab has dates; with no dates at all the last tab is used', async () => {
  const dated = await tabs([['ישן', 'ראשון 11/10'], ['טיוטה', null]]);
  assert.equal(dated.usedSheet, 'ישן');
  const none = await tabs([['א', null], ['ב', null]]);
  assert.equal(none.usedSheet, 'ב');
  assert.deepEqual(none.assignments.map((a) => a.soldier), ['ב דמה']);
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

test('a single-tab file still uses one week start and the user override', async () => {
  const { buildMainFixture } = await import('./fixtures/build.js');
  const single = await parseRoster(await buildMainFixture(), { fileName: 'f.xlsx', today: '2026-10-17', weekStartOverride: '2026-10-04' });
  assert.equal(single.weekStarts.length, 1);
  assert.equal(single.weekStart.source, 'user');
});
