// Upload → normalized, validated roster. The single source of data for every view.
import crypto from 'node:crypto';
import { readWorkbook } from './workbook.js';
import { findBlocks } from './blocks.js';
import { buildRoster } from './roster.js';
import { validateRoster } from './validate.js';
import { buildPostOptions, rosterDateRange } from './search.js';
import { groupBySoldier } from './soldiers.js';

export async function parseRoster(buffer, { fileName, today, weekStartOverride = null }) {
  const sheets = await readWorkbook(buffer);
  const sheetResults = sheets.map((sheet) =>
    sheet.hidden ? { sheet: sheet.name, hidden: true, blocks: [], unparsedRegions: [] } : { sheet: sheet.name, hidden: false, ...findBlocks(sheet) },
  );
  const roster = validateRoster(buildRoster(sheetResults, { today, weekStartOverride }));
  const options = buildPostOptions(roster.sections);
  const levels = { error: 0, warning: 0, info: 0 };
  for (const i of roster.issues) levels[i.level]++;
  return {
    version: crypto.randomBytes(9).toString('base64url'),
    fileName,
    sheets: sheetResults.map((s) => ({ name: s.sheet, hidden: s.hidden, tables: s.blocks.length })),
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
      soldiers: new Set(roster.assignments.map((a) => a.personKey)).size,
      assignments: roster.assignments.length,
      timed: roster.assignments.filter((a) => a.kind === 'timed').length,
      unresolved: roster.assignments.filter((a) => a.kind === 'unresolved').length,
      sections: options.length,
      positions: options.reduce((n, g) => n + g.positions.length, 0),
      issues: levels,
    },
  };
}
