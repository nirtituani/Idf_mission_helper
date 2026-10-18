// FICTIONAL test workbooks. Names are invented; layout mirrors the real roster format
// (stacked tables, merged title rows, vertically merged day cells, day names without dates,
// a date-only table, a date-range table, a stray side table). No real roster data here.
import ExcelJS from 'exceljs';

function table(ws, top, title, headers, rows) {
  ws.getCell(top, 1).value = title;
  if (headers.length > 1) ws.mergeCells(top, 1, top, headers.length);
  headers.forEach((h, i) => (ws.getCell(top + 1, i + 1).value = h));
  let r = top + 2;
  for (const [day, groupRows] of rows) {
    const first = r;
    for (const values of groupRows) {
      values.forEach((v, i) => {
        if (v !== null && v !== undefined) ws.getCell(r, i + 2).value = v;
      });
      r++;
    }
    ws.getCell(first, 1).value = day;
    if (r - 1 > first) ws.mergeCells(first, 1, r - 1, 1);
  }
  return r;
}

export async function buildMainFixture({ withExplicitDates = true } = {}) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('שיבוץ');

  // Patrol: roles as columns, day names only, overnight 22:00-06:00.
  table(ws, 1, 'סיור', ['יום', 'שעות', 'מפקד – סיור', 'לוחם – סיור'], [
    ['ראשון', [['14:00-22:00', null, null], ['22:00-06:00', 'אבי דמה', 'בני דמה']]],
    ['שני', [['06:00-14:00', 'גדי דמה', 'דני דמה'], ['14:00-22:00', 'הדר דמה', 'ורד דמה'], ['22:00-06:00', 'זיו דמה ', 'חן דמה']]],
  ]);

  // Static posts: posts as columns, 4h shifts incl. 20:00-24:00 and an overlap for "גדי דמה".
  table(ws, 10, 'סטטיות', ['יום', 'שעות', 'ש״ג', 'מזרחית'], [
    ['ראשון', [['16:00-20:00', 'טל דמה', 'יעל דמה'], ['20:00-24:00', 'כרם דמה', null]]],
    ['שני', [['00:00-04:00', 'לוטם דמה', 'מור דמה'], ['04:00-08:00', 'מחלקה 2', 'מחלקה 2'], ['08:00-12:00', 'גדי דמה', 'נוי דמה'], ['16:00-20:00', 'סהר דמה', 'עדי דמה'], ['16:00-20:00', 'סהר דמה', 'פז דמה']]],
  ]);
  // Side table without day/hours headers (must be reported, not parsed).
  ws.getCell('V12').value = 'ראשון-שלישי';
  ws.getCell('V13').value = 'צבי דמה';

  // Kitchen: task column, explicit dates, no hours.
  const kitchenDays = withExplicitDates ? ['ראשון 11/10', 'שני 12/10'] : ['ראשון', 'שני'];
  table(ws, 20, 'מטבח', ['יום', 'משימה', 'לוחם'], [
    [kitchenDays[0], [['מטבח 1 (עיבוי ש"ג)', 'קרן דמה'], ['מטבח 2', null]]],
    [kitchenDays[1], [['מטבח 1 (עיבוי ש"ג)', 'רון דמה/שי דמה'], ['מטבח 2', 'תום דמה(החלפה)'], [null, 'נטע דמה']]],
  ]);

  // Outpost: free-text date ranges — explicit, day-names continuation, and a non-continuable one.
  ws.getCell('A28').value = 'מוצב';
  ws.mergeCells('A28:C28');
  ['מתאריך – עד', 'מפקד', 'לוחם 1'].forEach((h, i) => (ws.getCell(29, i + 1).value = h));
  ws.getCell('A30').value = 'ראשון 11/10 00:00 – שלישי 13/10 11:00';
  ws.getCell('B30').value = 'אור דמה';
  ws.getCell('C30').value = 'אורי דמה';
  ws.getCell('A31').value = 'שלישי עד ראשוון';
  ws.getCell('B31').value = 'אלון דמה';
  ws.getCell('A32').value = 'רביעי עד שבת';
  ws.getCell('B32').value = 'עומר דמה';

  // Ops room with gershayim in the title and similar-name variants.
  table(ws, 34, 'חמ"ל', ['יום', 'שעות', 'חמליסט', 'רץ חמ"ל'], [
    ['ראשון', [['22:00-06:00', 'נווה דמה', 'חן']]],
    ['שני', [['06:00-14:00', 'נוה דמה', 'ליאור דמה*']]],
  ]);

  return Buffer.from(await wb.xlsx.writeBuffer());
}

// A different week with different tables — used to prove a new upload replaces all options.
export async function buildSecondFixture() {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Sheet1');
  table(ws, 1, 'שמירה', ['יום', 'שעות', 'עמדה צפונית'], [
    ['ראשון 18/10', [['08:00-12:00', 'ירדן דמה']]],
  ]);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

export async function buildBrokenTimesFixture() {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('שיבוץ');
  table(ws, 1, 'סיור', ['יום', 'שעות', 'מפקד'], [
    ['ראשון 11/10', [['25:00-03:00', 'אבי דמה'], ['10:00-10:00', 'בני דמה'], [null, 'גדי דמה']]],
    ['יומיים', [['08:00-12:00', 'דני דמה']]],
  ]);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

// FICTIONAL two-week workbook mirroring the second real layout: tab 1 = stacked tables (week 11/10),
// tab 2 = tables side by side (week 18/10), a range table under the patrol table, standby rows with
// day ranges ("ראשון - שני", "20:00 - 20:00"), and both tabs covering Sunday 18/10.
export async function buildTwoWeekFixture() {
  const wb = new ExcelJS.Workbook();
  const w1 = wb.addWorksheet('שבוע 1');
  table(w1, 1, 'כיתת כוננות', ['יום', 'שעות', 'מפקד'], [
    ['ראשון', [['17:30-05:30', 'ישן דמה']]],
    ['שני', [['05:30-17:30', 'ישן ב דמה']]],
  ]);
  table(w1, 6, 'מטבח', ['יום', 'משימה', 'לוחם'], [
    ['ראשון 11/10', [['מטבח 1', 'קודם דמה']]],
    ['ראשון 18/10', [['מטבח 1', 'מוחלף דמה']]],
  ]);
  // Sunday 18/10 standby in the OLD tab (overlaps the new tab's first standby shift)
  w1.getCell('A12').value = 'כיתת כוננות';
  ['יום', 'שעות', 'מפקד'].forEach((h, i) => (w1.getCell(13, i + 1).value = h));
  w1.getCell('A14').value = 'ראשון 18/10';
  w1.getCell('B14').value = '17:30-05:30';
  w1.getCell('C14').value = 'ישן ג דמה';

  const w2 = wb.addWorksheet('שבוע 2');
  // A–C: patrol (day names only)
  table(w2, 1, 'סיור', ['יום', 'שעות', 'מפקד'], [
    ['ראשון', [['22:00-06:00', 'סייר א דמה']]],
    ['שני', [['06:00-14:00', 'סייר ב דמה']]],
  ]);
  // E–G: standby with day ranges; last row has a time but no names
  w2.getCell('E1').value = 'כיתת כוננות';
  w2.mergeCells('E1:G1');
  ['יום', 'שעות', 'מפקד'].forEach((h, i) => (w2.getCell(2, i + 5).value = h));
  [['ראשון - שני', '17:30-20:00', 'חדש א דמה'], ['שני - שלישי', '20:00 - 20:00', 'חדש ב דמה'], ['ראשון ', '20:00 - 20:00', null]].forEach(([d, t, n], i) => {
    w2.getCell(3 + i, 5).value = d;
    w2.getCell(3 + i, 6).value = t;
    if (n) w2.getCell(3 + i, 7).value = n;
  });
  // I–K: static posts — a long table that continues past the range table's header row (row 9)
  w2.getCell('I1').value = 'סטטיות';
  w2.mergeCells('I1:K1');
  ['יום', 'שעות', 'ש״ג'].forEach((h, i) => (w2.getCell(2, i + 9).value = h));
  const staticRows = [['ראשון', '16:00-20:00', 'שומר א דמה'], ['שני', '00:00-04:00', 'שומר ב דמה'], ['שני', '04:00-08:00', 'שומר ג דמה'], ['שני', '08:00-12:00', 'שומר ד דמה'], ['שני', '12:00-16:00', 'שומר ה דמה'], ['שני', '16:00-20:00', 'שומר ו דמה'], ['שני', '20:00-24:00', 'שומר ז דמה'], ['שלישי', '00:00-04:00', 'שומר ח דמה'], ['שלישי', '04:00-08:00', 'שומר ט דמה'], ['שלישי', '08:00-12:00', 'שומר י דמה']];
  staticRows.forEach(([d, t, n], i) => {
    w2.getCell(3 + i, 9).value = d;
    w2.getCell(3 + i, 10).value = t;
    w2.getCell(3 + i, 11).value = n;
  });
  // B8–C10: a date-range table under the patrol table (header on row 9 — beside the static table)
  w2.getCell('B8').value = 'מוצב';
  w2.mergeCells('B8:C8');
  w2.getCell('B9').value = 'מתאריך – עד';
  w2.getCell('C9').value = 'מפקד';
  w2.getCell('B10').value = 'ראשון 18/10 17:00 – רביעי 21/10 17:00';
  w2.getCell('C10').value = 'מוצבניק דמה';
  // M–O: kitchen with explicit dates (anchors this tab to 18/10)
  w2.getCell('M1').value = 'מטבח';
  w2.mergeCells('M1:O1');
  ['יום', 'משימה', 'לוחם'].forEach((h, i) => (w2.getCell(2, i + 13).value = h));
  [['ראשון 18/10', 'מטבח 1', 'מטבחון דמה'], ['שני 19/10', 'מטבח 1', 'מטבחון ב דמה']].forEach(([d, t, n], i) => {
    w2.getCell(3 + i, 13).value = d;
    w2.getCell(3 + i, 14).value = t;
    w2.getCell(3 + i, 15).value = n;
  });
  return Buffer.from(await wb.xlsx.writeBuffer());
}
