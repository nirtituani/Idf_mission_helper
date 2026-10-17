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
    ['שני', [['00:00-04:00', 'לוטם דמה', 'מור דמה'], ['08:00-12:00', 'גדי דמה', 'נוי דמה'], ['16:00-20:00', 'סהר דמה', 'עדי דמה'], ['16:00-20:00', 'סהר דמה', 'פז דמה']]],
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
