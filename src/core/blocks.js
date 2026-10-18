// Finds the roster tables ("blocks") inside a sheet grid.
//
// A block is recognised structurally:
//   header row  - a row containing a "יום" (day) or "מתאריך – עד" (date range) cell; the header
//                 continues rightwards (increasing column) through contiguous non-empty cells.
//   title       - the cell directly above the header's first cell (e.g. a merged "סיור" row).
//   data rows   - every following row with content inside the header's columns, until a blank
//                 row, another header row, or the title row of the next block. Only headers that
//                 overlap this table's columns count — tables may sit side by side.
// Header columns are classified by keyword: יום → day, שעות/שעה → hours, משימה → task,
// מתאריך–עד → date range. Every other header is a person column labelled by its own text.
// Non-empty cells outside every block are reported as unparsed regions, never guessed at.
import { headerKey } from './text.js';

const DAY_HEADERS = new Set(['יום']);
const RANGE_HEADERS = new Set(['מתאריך-עד']);
const TIME_HEADERS = new Set(['שעות', 'שעה']);
const TASK_HEADERS = new Set(['משימה']);

export function findBlocks(sheet) {
  const { cells } = sheet;
  const get = (r, c) => cells.get(`${r}:${c}`);
  const text = (r, c) => get(r, c)?.text || '';
  const consumed = new Set();
  const consume = (r, c) => {
    const cell = get(r, c);
    if (cell) consumed.add(cell.addr);
  };

  const headerStarts = [];
  for (const cell of cells.values()) {
    if (cell.masterAddr) continue;
    const k = headerKey(cell.text);
    if (DAY_HEADERS.has(k) || RANGE_HEADERS.has(k)) headerStarts.push(cell);
  }
  headerStarts.sort((a, b) => a.r - b.r || a.c - b.c);
  // Column extent of every header row: from its יום/מתאריך cell rightwards through contiguous cells.
  const headerSpans = headerStarts.map((h) => {
    let c1 = h.c;
    while (text(h.r, c1 + 1)) c1++;
    return { r: h.r, c0: h.c, c1 };
  });
  const headerNear = (r, c0, c1) => headerSpans.some((h) => h.r === r && h.c0 <= c1 && h.c1 >= c0);

  const blocks = [];
  for (const start of headerStarts) {
    const cols = [];
    for (let c = start.c; text(start.r, c); c++) {
      const cell = get(start.r, c);
      const k = headerKey(cell.text);
      let kind = 'person';
      if (DAY_HEADERS.has(k)) kind = 'day';
      else if (RANGE_HEADERS.has(k)) kind = 'range';
      else if (TIME_HEADERS.has(k)) kind = 'time';
      else if (TASK_HEADERS.has(k)) kind = 'task';
      cols.push({ c, kind, label: cell.text, addr: cell.addr });
      consume(start.r, c);
    }

    const titleCell = get(start.r - 1, start.c);
    let title = null;
    const c0 = cols[0].c;
    const c1 = cols[cols.length - 1].c;
    if (titleCell && titleCell.text && !headerNear(start.r - 1, c0, c1)) {
      title = { text: titleCell.text, addr: titleCell.masterAddr || titleCell.addr };
      for (const cell of cells.values()) {
        if (cell.r === start.r - 1 && (cell.addr === title.addr || cell.masterAddr === title.addr)) {
          consumed.add(cell.addr);
        }
      }
    }

    const colOf = (kind) => cols.find((x) => x.kind === kind);
    const dayCol = colOf('day');
    const rangeCol = colOf('range');
    const timeCol = colOf('time');
    const taskCol = colOf('task');
    const personCols = cols.filter((x) => x.kind === 'person');

    const rows = [];
    for (let r = start.r + 1; ; r++) {
      if (headerNear(r, c0, c1) || headerNear(r + 1, c0, c1)) break;
      if (!cols.some((x) => text(r, x.c))) break;
      const cellInfo = (col) => {
        if (!col) return null;
        const cell = get(r, col.c);
        return {
          text: cell?.text || '',
          raw: cell?.raw || '',
          addr: cell?.addr || `${columnLetter(col.c)}${r}`,
          merged: Boolean(cell?.merged),
          masterAddr: cell?.masterAddr || null,
        };
      };
      rows.push({
        r,
        day: cellInfo(dayCol),
        range: cellInfo(rangeCol),
        time: cellInfo(timeCol),
        task: cellInfo(taskCol),
        persons: personCols.map((col) => ({ col, ...cellInfo(col) })),
      });
      for (const col of cols) consume(r, col.c);
    }

    blocks.push({
      sheet: sheet.name,
      headerRow: start.r,
      title,
      kind: rangeCol ? 'range' : 'day',
      hasTime: Boolean(timeCol),
      hasTask: Boolean(taskCol),
      cols,
      personCols,
      rows,
    });
  }

  return { blocks, unparsedRegions: findUnparsedRegions(cells, consumed) };
}

function findUnparsedRegions(cells, consumed) {
  const leftover = new Map();
  for (const cell of cells.values()) {
    if (!cell.text || consumed.has(cell.addr)) continue;
    if (cell.masterAddr && consumed.has(cell.masterAddr)) continue;
    leftover.set(`${cell.r}:${cell.c}`, cell);
  }
  const seen = new Set();
  const regions = [];
  for (const [key, cell] of leftover) {
    if (seen.has(key)) continue;
    const stack = [cell];
    seen.add(key);
    const members = [];
    while (stack.length) {
      const cur = stack.pop();
      members.push(cur);
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          const k = `${cur.r + dr}:${cur.c + dc}`;
          if (leftover.has(k) && !seen.has(k)) {
            seen.add(k);
            stack.push(leftover.get(k));
          }
        }
      }
    }
    members.sort((a, b) => a.r - b.r || a.c - b.c);
    const r0 = Math.min(...members.map((m) => m.r));
    const r1 = Math.max(...members.map((m) => m.r));
    const c0 = Math.min(...members.map((m) => m.c));
    const c1 = Math.max(...members.map((m) => m.c));
    regions.push({
      range: `${columnLetter(c0)}${r0}:${columnLetter(c1)}${r1}`,
      count: members.length,
      sample: members.slice(0, 4).map((m) => m.text),
    });
  }
  return regions.sort((a, b) => a.range.localeCompare(b.range));
}

export function columnLetter(c) {
  let s = '';
  for (let n = c; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}
