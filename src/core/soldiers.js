// Roster grouped by soldier (merged identity from people.js). Built from the same normalized
// assignments as the search, so both views always agree.

import { isUnitName } from './people.js';

// A cell holding alternates or a note ("א/ב", "א(ב)") is not one identifiable soldier.
const AMBIGUOUS = /[/\\()]/;

export function groupBySoldier(assignments, issues) {
  const issueIdsByAssignment = new Map();
  for (const issue of issues) {
    if (issue.level === 'info') continue;
    for (const id of issue.assignmentIds) {
      if (!issueIdsByAssignment.has(id)) issueIdsByAssignment.set(id, new Set());
      issueIdsByAssignment.get(id).add(issue.id);
    }
  }

  const byKey = new Map();
  for (const a of assignments) {
    if (isUnitName(a.person)) continue; // units are not soldiers
    if (!byKey.has(a.personKey)) byKey.set(a.personKey, { key: a.personKey, name: a.person, spellings: new Set(), assignments: [] });
    const s = byKey.get(a.personKey);
    s.spellings.add(a.soldier);
    s.assignments.push(a);
  }

  const order = (x, y) => (x.startKey ?? Infinity) - (y.startKey ?? Infinity) || Number(x.id.slice(1)) - Number(y.id.slice(1));
  return [...byKey.values()]
    .map((s) => {
      s.assignments.sort(order);
      const issueIds = new Set(s.assignments.flatMap((a) => [...(issueIdsByAssignment.get(a.id) || [])]));
      return {
        key: s.key,
        name: s.name,
        spellings: [...s.spellings],
        ambiguous: AMBIGUOUS.test(s.name),
        assignmentIds: s.assignments.map((a) => a.id),
        timedCount: s.assignments.filter((a) => a.kind === 'timed').length,
        unresolvedCount: s.assignments.filter((a) => a.kind === 'unresolved').length,
        issueIds: [...issueIds],
      };
    })
    .sort((x, y) => x.name.localeCompare(y.name, 'he'));
}
