// Upload → normalized, validated roster. The single source of data for every view.
import crypto from 'node:crypto';
import { readWorkbook } from './workbook.js';
import { findBlocks } from './blocks.js';
import { buildRoster, detectFirstDates } from './roster.js';
import { validateRoster } from './validate.js';
import { buildPostOptions, rosterDateRange } from './search.js';
import { groupBySoldier } from './soldiers.js';
import { isUnitName } from './people.js';
import { sheetGrid } from './grid.js';

export async function parseRoster(buffer, { fileName, today, weekStartOverride = null }) {
  const sheets = await readWorkbook(buffer);
  const sheetResults = sheets.map((sheet) =>
    sheet.hidden ? { sheet: sheet.name, hidden: true, blocks: [], unparsedRegions: [] } : { sheet: sheet.name, hidden: false, ...findBlocks(sheet) },
  );
  const usedSheet = newestWeekSheet(sheetResults, today);
  const used = sheetResults.map((s) => (s.sheet === usedSheet ? s : { ...s, blocks: [], unparsedRegions: [] }));
  const roster = validateRoster(buildRoster(used, { today, weekStartOverride }));
  const options = buildPostOptions(roster.sections);
  const levels = { error: 0, warning: 0, info: 0 };
  for (const i of roster.issues) levels[i.level]++;
  return {
    version: crypto.randomBytes(9).toString('base64url'),
    fileName,
    sheets: sheetResults.map((s) => ({ name: s.sheet, hidden: s.hidden, tables: s.blocks.length, ignored: s.sheet !== usedSheet })),
    usedSheet,
    grid: sheetGrid(sheets.find((s) => s.name === usedSheet)),
    weekStart: roster.weekStart,
    weekStarts: roster.weekStarts,
    detectedWeekStart: roster.detectedWeekStart,
    dateRange: rosterDateRange(roster),
    options,
    assignments: roster.assignments,
    slots: roster.slots,
    issues: roster.issues,
    soldiers: groupBySoldier(roster.assignments, roster.issues),
    summary: {
      soldiers: new Set(roster.assignments.filter((a) => !isUnitName(a.person)).map((a) => a.personKey)).size,
      assignments: roster.assignments.length,
      timed: roster.assignments.filter((a) => a.kind === 'timed').length,
      unresolved: roster.assignments.filter((a) => a.kind === 'unresolved').length,
      sections: options.length,
      positions: options.reduce((n, g) => n + g.positions.length, 0),
      issues: levels,
    },
  };
}

// A new tab is added for each week: only the newest week's tab is read (by request). Newest = the
// latest explicit date; tabs without any date are used only when no tab has one (then the last tab).
function newestWeekSheet(sheetResults, today) {
  const withTables = sheetResults.filter((s) => s.blocks.length);
  if (!withTables.length) return null;
  const dates = detectFirstDates(withTables, today);
  let best = null;
  for (const s of withTables) {
    const d = dates.get(s.sheet)?.firstDate;
    if (d && (!best || d >= best.d)) best = { sheet: s.sheet, d };
  }
  return best ? best.sheet : withTables.at(-1).sheet;
}
