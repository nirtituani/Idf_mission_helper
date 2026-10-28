// The used tab as a plain grid, so the browser can show the file as it is and point at the cells
// an issue refers to. Text is the cell's own text; merged cells become one cell with a span.
const MAX_ROWS = 600;
const MAX_COLS = 80;

// sheet = { name, cells, styles } from readWorkbook →
// { sheet, rows, cols, cells: [{ r, c, addr, text, rs?, cs?, fill?, bold? }] }  (merged non-master cells omitted)
export function sheetGrid(sheet) {
  if (!sheet) return null;
  const byAddr = new Map([...sheet.cells.values()].map((x) => [x.addr, x]));
  const span = new Map(); // master addr → { r2, c2 }
  const covered = new Set();
  let rows = 0;
  let cols = 0;
  for (const x of sheet.cells.values()) {
    if (x.text) {
      rows = Math.max(rows, x.r);
      cols = Math.max(cols, x.c);
    }
    if (!x.masterAddr) continue;
    const m = byAddr.get(x.masterAddr);
    if (!m) continue;
    covered.add(`${x.r}:${x.c}`);
    const s = span.get(m.addr) ?? { r2: m.r, c2: m.c };
    span.set(m.addr, { r2: Math.max(s.r2, x.r), c2: Math.max(s.c2, x.c) });
  }
  rows = Math.min(rows, MAX_ROWS);
  cols = Math.min(cols, MAX_COLS);
  const cells = [];
  for (let r = 1; r <= rows; r++) {
    for (let c = 1; c <= cols; c++) {
      const key = `${r}:${c}`;
      if (covered.has(key)) continue;
      const x = sheet.cells.get(key);
      const style = sheet.styles?.get(key);
      if (!x?.text && !style?.fill) continue;
      const cell = { r, c, addr: x?.addr ?? address(r, c), text: x?.text ?? '' };
      const s = x && span.get(x.addr);
      if (s && s.r2 > r) cell.rs = Math.min(s.r2, rows) - r + 1;
      if (s && s.c2 > c) cell.cs = Math.min(s.c2, cols) - c + 1;
      if (style?.fill) cell.fill = style.fill;
      if (style?.bold) cell.bold = true;
      cells.push(cell);
    }
  }
  return { sheet: sheet.name, rows, cols, cells };
}

export function columnName(c) {
  let s = '';
  for (let n = c; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

const address = (r, c) => `${columnName(c)}${r}`;
