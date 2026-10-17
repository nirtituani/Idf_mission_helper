// Reads an .xlsx buffer into plain cell grids. This is the only module that touches ExcelJS.
import ExcelJS from 'exceljs';
import { cleanText, cellToString } from './text.js';

// Returns [{ name, hidden, cells: Map<"r:c", Cell> }]
// Cell = { r, c, addr, text, raw, merged, masterAddr }  (masterAddr set only on merged non-master cells)
export async function readWorkbook(buffer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  const sheets = [];
  wb.eachSheet((ws) => {
    const cells = new Map();
    ws.eachRow({ includeEmpty: false }, (row, r) => {
      row.eachCell({ includeEmpty: false }, (cell, c) => {
        const isSlave = cell.isMerged && cell.master && cell.master.address !== cell.address;
        const raw = cellToString(cell.value);
        cells.set(`${r}:${c}`, {
          r,
          c,
          addr: cell.address,
          text: cleanText(cell.value),
          raw,
          merged: Boolean(cell.isMerged),
          masterAddr: isSlave ? cell.master.address : null,
        });
      });
    });
    sheets.push({ name: ws.name, hidden: ws.state && ws.state !== 'visible', cells });
  });
  return sheets;
}
