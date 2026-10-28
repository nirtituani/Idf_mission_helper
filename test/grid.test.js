// The used tab as a grid for the "הקובץ" view: text, merged cells as spans, fill colours. Fictional data.
import test from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import { readWorkbook } from '../src/core/workbook.js';
import { sheetGrid, columnName } from '../src/core/grid.js';
import { parseRoster } from '../src/core/index.js';
import { buildMainFixture, buildTwoWeekFixture } from './fixtures/build.js';

async function grid(build) {
  const wb = new ExcelJS.Workbook();
  build(wb.addWorksheet('לוח'));
  const [sheet] = await readWorkbook(await wb.xlsx.writeBuffer());
  return sheetGrid(sheet);
}

test('merged cells become one cell with a row/column span; covered cells are omitted', async () => {
  const g = await grid((ws) => {
    ws.getCell('A1').value = 'כותרת';
    ws.mergeCells('A1:C1');
    ws.getCell('A2').value = 'ראשון';
    ws.mergeCells('A2:A4');
    ws.getCell('B2').value = 'דנה דמה';
    ws.getCell('C4').value = 'x';
  });
  assert.equal(g.sheet, 'לוח');
  assert.deepEqual([g.rows, g.cols], [4, 3]);
  const at = (addr) => g.cells.find((c) => c.addr === addr);
  assert.deepEqual([at('A1').cs, at('A1').rs], [3, undefined]);
  assert.deepEqual([at('A2').rs, at('A2').cs], [3, undefined]);
  assert.equal(at('B1'), undefined);
  assert.equal(at('A3'), undefined);
  assert.equal(at('B2').text, 'דנה דמה');
});

test('solid fill colours and bold are kept; white fill is ignored; a coloured empty cell is shown', async () => {
  const g = await grid((ws) => {
    ws.getCell('A1').value = 'צבע';
    ws.getCell('A1').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD9EAD3' } };
    ws.getCell('A1').font = { bold: true };
    ws.getCell('B1').value = 'לבן';
    ws.getCell('B1').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFFFFF' } };
    ws.getCell('A2').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF4CCCC' } };
    ws.getCell('B2').value = 'y';
  });
  const at = (addr) => g.cells.find((c) => c.addr === addr);
  assert.deepEqual([at('A1').fill, at('A1').bold], ['#D9EAD3', true]);
  assert.equal(at('B1').fill, undefined);
  assert.deepEqual(at('A2'), { r: 2, c: 1, addr: 'A2', text: '', fill: '#F4CCCC' });
});

test('columnName: A, Z, AA, AZ, BA', () => {
  assert.deepEqual([1, 26, 27, 52, 53].map(columnName), ['A', 'Z', 'AA', 'AZ', 'BA']);
});

test('the roster carries the grid of the used tab only', async () => {
  const one = await parseRoster(await buildMainFixture(), { fileName: 'a.xlsx', today: '2026-10-17' });
  assert.equal(one.grid.sheet, one.usedSheet);
  assert.ok(one.grid.cells.some((c) => c.text === one.assignments[0].soldier));
  const two = await parseRoster(await buildTwoWeekFixture(), { fileName: 'b.xlsx', today: '2026-10-17' });
  assert.equal(two.grid.sheet, two.usedSheet);
});
