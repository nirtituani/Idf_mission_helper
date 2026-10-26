// Workload warnings: more than 12 hours of shifts within 24 hours, and under 8 hours of rest.
import test from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import { parseRoster } from '../src/core/index.js';

// rows: [day label, hours, name]; one table "שמירה" with day / hours / guard columns.
// kitchen: [day label, name] rows of a whole-day table (no hours column) below it.
async function roster(rows, kitchen = []) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('a');
  ws.getCell('A1').value = 'שמירה';
  ['יום', 'שעות', 'שומר'].forEach((h, i) => (ws.getCell(2, i + 1).value = h));
  rows.forEach((r, i) => r.forEach((v, j) => (ws.getCell(3 + i, j + 1).value = v)));
  if (kitchen.length) {
    const top = rows.length + 4;
    ws.getCell(top, 1).value = 'מטבח';
    ['יום', 'תורן מטבח'].forEach((h, i) => (ws.getCell(top + 1, i + 1).value = h));
    kitchen.forEach((r, i) => r.forEach((v, j) => (ws.getCell(top + 2 + i, j + 1).value = v)));
  }
  return parseRoster(Buffer.from(await wb.xlsx.writeBuffer()), { fileName: 'f.xlsx', today: '2026-10-17' });
}
const of = (r, code) => r.issues.filter((i) => i.code === code);

test('more than 12 hours within 24 hours is one LONG_DAY warning listing the shifts', async () => {
  const r = await roster([
    ['ראשון 11/10', '06:00-14:00', 'דני דמה'],
    ['ראשון 11/10', '22:00-02:00', 'דני דמה'],
    ['שני 12/10', '04:00-06:00', 'דני דמה'],
  ]);
  const [w, ...rest] = of(r, 'LONG_DAY');
  assert.equal(rest.length, 0);
  assert.equal(w.level, 'warning');
  assert.match(w.message, /"דני דמה" משובץ ל־14 שעות בתוך 24 שעות/);
  assert.equal(w.assignmentIds.length, 3);
});

test('exactly 12 hours within 24 hours is fine', async () => {
  const r = await roster([
    ['ראשון 11/10', '06:00-14:00', 'דני דמה'],
    ['שני 12/10', '02:00-06:00', 'דני דמה'],
  ]);
  assert.equal(of(r, 'LONG_DAY').length, 0);
});

test('rest under 8 hours between shifts is a SHORT_REST warning; 8 hours is fine', async () => {
  const r = await roster([
    ['ראשון 11/10', '06:00-10:00', 'דני דמה'],
    ['ראשון 11/10', '14:00-18:00', 'דני דמה'],
    ['שני 12/10', '02:00-06:00', 'דני דמה'],
  ]);
  const short = of(r, 'SHORT_REST');
  assert.equal(short.length, 1);
  assert.equal(short[0].level, 'warning');
  assert.match(short[0].message, /"דני דמה" — רק 4 שעות מנוחה בין/);
  assert.equal(short[0].assignmentIds.length, 2);
});

test('back-to-back shifts say "ללא מנוחה"; half hours are shown', async () => {
  const r = await roster([
    ['ראשון 11/10', '06:00-10:00', 'דני דמה'],
    ['ראשון 11/10', '10:00-12:00', 'דני דמה'],
    ['ראשון 11/10', '17:30-19:00', 'דני דמה'],
  ]);
  const msgs = of(r, 'SHORT_REST').map((i) => i.message);
  assert.equal(msgs.length, 2);
  assert.match(msgs[0], /"דני דמה" — ללא מנוחה בין/);
  assert.match(msgs[1], /רק 5.5 שעות מנוחה/);
});

test('long tasks (over 12 hours, e.g. a 24h duty or kitchen) are not counted; overlaps stay OVERLAP only', async () => {
  const r = await roster([
    ['ראשון 11/10', '06:00-19:00', 'דני דמה'],
    ['ראשון 11/10', '21:00-23:00', 'דני דמה'],
    ['ראשון 11/10', '06:00-14:00', 'משה דמה'],
    ['ראשון 11/10', '12:00-16:00', 'משה דמה'],
  ]);
  assert.equal(of(r, 'LONG_DAY').length, 0);
  assert.equal(of(r, 'SHORT_REST').length, 0);
  assert.equal(of(r, 'OVERLAP').length, 1);
});

test('a unit ("מחלקה 2") gets no workload warnings', async () => {
  const r = await roster([
    ['ראשון 11/10', '06:00-14:00', 'מחלקה 2'],
    ['ראשון 11/10', '16:00-22:00', 'מחלקה 2'],
  ]);
  assert.equal(of(r, 'LONG_DAY').length + of(r, 'SHORT_REST').length, 0);
});

test('kitchen counts as 06:00–22:00 for rest: a shift close to it is SHORT_REST; alone or far from it is fine', async () => {
  const r = await roster(
    [
      ['ראשון 11/10', '20:00-24:00', 'דני דמה'],
      ['שלישי 13/10', '00:00-04:00', 'משה דמה'],
      ['חמישי 15/10', '10:00-14:00', 'רון דמה'],
    ],
    [['שני 12/10', 'דני דמה'], ['שני 12/10', 'משה דמה'], ['שני 12/10', 'גיל דמה'], ['רביעי 14/10', 'רון דמה']],
  );
  const short = of(r, 'SHORT_REST').map((i) => i.message);
  assert.equal(short.length, 2);
  assert.match(short.find((m) => m.startsWith('"דני דמה"')), /רק 6 שעות מנוחה/);
  assert.match(short.find((m) => m.startsWith('"משה דמה"')), /רק 2 שעות מנוחה/);
  assert.equal(of(r, 'LONG_DAY').length, 0);
  assert.equal(of(r, 'OVERLAP').length, 0);
});
