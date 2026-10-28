// Reads an .xlsx buffer into plain cell grids. This is the only module that touches ExcelJS.
import ExcelJS from 'exceljs';
import { cleanText, cellToString } from './text.js';

// Returns [{ name, hidden, cells: Map<"r:c", Cell>, styles: Map<"r:c", Style> }]
// Cell = { r, c, addr, text, raw, merged, masterAddr }  (masterAddr set only on merged non-master cells)
// Style = { fill, bold }  (only for cells with a solid fill colour or bold text; used to show the file as-is)
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
    const styles = new Map();
    ws.eachRow({ includeEmpty: true }, (row, r) => {
      row.eachCell({ includeEmpty: true }, (cell, c) => {
        const argb = cell.fill?.type === 'pattern' && cell.fill.pattern === 'solid' ? cell.fill.fgColor?.argb : null;
        const fill = /^[0-9A-F]{8}$/i.test(argb ?? '') && !/FFFFFF$/i.test(argb) ? `#${argb.slice(2)}` : null;
        const bold = Boolean(cell.font?.bold);
        if (fill || bold) styles.set(`${r}:${c}`, { fill, bold });
      });
    });
    sheets.push({ name: ws.name, hidden: ws.state && ws.state !== 'visible', cells, styles });
  });
  return sheets;
}
