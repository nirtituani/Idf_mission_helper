// Upload → normalized, validated roster. The single source of data for every view.
import crypto from 'node:crypto';
import { readWorkbook } from './workbook.js';
import { findBlocks } from './blocks.js';
import { buildRoster } from './roster.js';
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
  // A new tab is added for each week: only the last tab with tables (this week) is read (by request).
  const usedSheet = sheetResults.filter((s) => s.blocks.length).at(-1)?.sheet ?? null;
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

