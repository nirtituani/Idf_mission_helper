// Turns detected blocks into the normalized roster model shared by every view.
//
// Dating rules (explicit and tested):
//   * A day cell with a date ("ראשון 11/10") uses that date. A missing year is resolved to the
//     year (±1 of the reference) in which that date falls on the stated weekday.
//   * Each sheet (tab) is its own week: its week start = the Sunday on/before the earliest explicit
//     date in that sheet. The user's override replaces it for a single-sheet workbook, and fills in
//     sheets that have no explicit date. Without either, day-name-only rows stay undated (error).
//   * A day cell may name two consecutive days ("ראשון - שני"): each shift starts on the first day
//     at its start time and ends on the second day at its end time ("20:00 - 20:00" = 24 hours,
//     "17:30-20:00" = Sunday 17:30 → Monday 20:00).
//   * In a block of day names only, the first day maps to the first matching weekday on/after the
//     week start; each following day to the next matching weekday after the previous day.
//   * Rows of the same day are grouped by the merged day cell (or identical consecutive label).
// Assignment kinds:
//   timed      - has a reliable [start, end) interval. A table without an hours column (kitchen)
//                is whole-day duty: 00:00–24:00 of its date (allDay: true).
//   unresolved - date or time could not be determined; reported, never guessed
import {
  addDays,
  dayNumber,
  keyToParts,
  minuteKey,
  nextWeekdayOnOrAfter,
  parseDayLabel,
  parseTimeOfDay,
  parseTimeRange,
  resolveYear,
  weekdayOf,
  HEBREW_DAYS,
} from './dates.js';
import { matchKey } from './text.js';

export function buildRoster(sheetResults, { today, weekStartOverride = null }) {
  const issues = [];
  const addIssue = (level, code, message, cells = [], assignmentIds = []) => {
    const issue = { id: `i${issues.length + 1}`, level, code, message, cells, assignmentIds };
    issues.push(issue);
    return issue;
  };
  const ref = (sheet, addr) => `${sheet}!${addr}`;

  // ---- 1. Week start from explicit dates -------------------------------------------------
  const detectedBySheet = detectFirstDates(sheetResults, today);
  const usedSheets = sheetResults.filter((s) => s.blocks.length).map((s) => s.sheet);
  const multiSheet = usedSheets.length > 1;
  const weekStarts = usedSheets.map((sheet) => {
    const d = detectedBySheet.get(sheet);
    const detectedWs = d ? { date: addDays(d.firstDate, -weekdayOf(d.firstDate)), cell: d.cell, text: d.text } : null;
    if (weekStartOverride && (!multiSheet || !detectedWs)) return { sheet, date: weekStartOverride, source: 'user', cell: null, text: null, detected: detectedWs };
    if (detectedWs) return { sheet, ...detectedWs, source: 'workbook', detected: detectedWs };
    return { sheet, date: null, source: null, cell: null, text: null, detected: null };
  });
  const weekStartOf = (sheet) => weekStarts.find((w) => w.sheet === sheet)?.date ?? null;

  // ---- 2. Assignments ---------------------------------------------------------------------
  const assignments = [];
  const slots = [];
  const sections = [];
  const sectionByKey = new Map();
  const missingWeekStartCells = [];

  const sectionFor = (block) => {
    const label = block.title ? block.title.text : null;
    const key = label ? matchKey(label) : `__untitled__${block.sheet}__${block.headerRow}`;
    if (!sectionByKey.has(key)) {
      const s = { key, label, positions: [], positionKeys: new Set() };
      sectionByKey.set(key, s);
      sections.push(s);
    }
    return sectionByKey.get(key);
  };
  const addPosition = (section, label) => {
    const key = matchKey(label);
    if (!section.positionKeys.has(key)) {
      section.positionKeys.add(key);
      section.positions.push({ key, label });
    }
    return key;
  };

  // One person cell → one assignment per soldier named in it (see splitCell).
  const addCell = (base, position, positionKey, person, kind, interval) => {
    const people = splitCell(person.text);
    const created = people.map(({ name, note }) => {
      const a = makeAssignment(assignments, base, position, positionKey, name, kind, interval);
      a.source.cellText = person.text;
      if (note) a.note = note;
      if (people.length > 1) a.sharedWith = people.filter((p) => p.name !== name).map((p) => p.name);
      return a;
    });
    const where = [ref(base.source.sheet, person.addr)];
    if (people.length > 1) {
      addIssue('info', 'SHARED_CELL', `התא "${person.text}" כולל ${people.length} חיילים — השיבוץ נרשם לכל אחד מהם.`, where, created.map((a) => a.id));
    }
    for (const { name, note } of people) {
      if (note) addIssue('info', 'CELL_NOTE', `בתא "${person.text}" החייל הוא "${name}"; "${note}" נשמר כהערה.`, where, created.map((a) => a.id));
    }
    return created;
  };

  for (const { sheet: sheetName, blocks } of sheetResults) {
    const weekStart = weekStartOf(sheetName);
    const yearRef = weekStart || today;
    for (const block of blocks) {
      const section = sectionFor(block);
      if (!block.title) {
        addIssue('warning', 'MISSING_TITLE', `לטבלה בשורה ${block.headerRow} אין כותרת — העמדות שלה מוצגות תחת "ללא כותרת".`, [ref(block.sheet, `A${block.headerRow}`)]);
      }
      if (!block.hasTask) for (const col of block.personCols) addPosition(section, col.label);
      if (block.kind === 'day' && !block.hasTime) {
        addIssue('info', 'WHOLE_DAY_BLOCK', `בטבלה "${section.label ?? 'ללא כותרת'}" אין עמודת שעות — כל שיבוץ בה נחשב לתורנות של יום שלם (00:00–24:00).`, [ref(block.sheet, block.cols[0].addr)]);
      }

      const base = (row, person) => ({
        sheet: block.sheet,
        section: section.label,
        sectionKey: section.key,
        columnLabel: person.col.label,
        source: {
          sheet: block.sheet,
          cell: person.addr,
          header: person.col.addr,
          title: block.title?.addr || null,
          day: row.day?.masterAddr || row.day?.addr || null,
          dayText: row.day?.text || null,
          time: row.time?.addr || row.range?.addr || null,
          timeText: row.time?.text || row.range?.text || null,
          task: row.task?.addr || null,
        },
      });

      // Position: task blocks take it from the task cell, others from the column header.
      const positionOf = (row, person) => {
        if (!block.hasTask) return { position: person.col.label, positionKey: matchKey(person.col.label) };
        if (!row.task?.text) return { position: null, positionKey: null };
        return { position: row.task.text, positionKey: addPosition(section, row.task.text) };
      };

      // A name cell merged down several rows repeats its text on each row; with the same post and
      // hours (e.g. a merged time cell too) it is one shift, not one per row.
      const mergedShifts = new Set();
      const isMergedRepeat = (person, positionKey, interval) => {
        const key = `${person.masterAddr || person.addr}|${positionKey}|${interval?.startKey}|${interval?.endKey}`;
        const seen = mergedShifts.has(key);
        mergedShifts.add(key);
        return Boolean(person.masterAddr) && seen;
      };

      if (block.kind === 'range') {
        let prevEndKey = null;
        for (const row of block.rows) {
          const rg = parseRangeText(row.range.text);
          let interval = null;
          if (rg) {
            const fromDate = resolveYear(rg.from, yearRef);
            const toDate = resolveYear(rg.to, yearRef);
            if (fromDate && toDate) {
              const startKey = minuteKey(fromDate, rg.from.minutes);
              const endKey = minuteKey(toDate, rg.to.minutes);
              if (endKey > startKey) interval = { date: fromDate, startKey, endKey };
            }
          } else if (prevEndKey !== null) {
            interval = continueRange(row.range.text, prevEndKey);
            if (interval) {
              const s = keyToParts(interval.startKey);
              const e = keyToParts(interval.endKey);
              addIssue(
                'info',
                'RANGE_INFERRED',
                `"${row.range.text}" פורש כ־${dm(s.date)} ${s.time} עד ${dm(e.date)} ${e.time}: ממשיך מסיום השורה הקודמת ומסתיים ביום שצוין באותה שעת החלפה.`,
                [ref(block.sheet, row.range.addr)],
              );
            }
          }
          prevEndKey = interval ? interval.endKey : null;
          const rowAssignments = [];
          for (const person of row.persons) {
            const { position, positionKey } = positionOf(row, person);
            if (!person.text) {
              if (interval) slots.push(makeSlot(block, section, position, positionKey, person, interval, row));
              continue;
            }
            if (isMergedRepeat(person, positionKey, interval)) continue;
            rowAssignments.push(...addCell(base(row, person), position, positionKey, person, interval ? 'timed' : 'unresolved', interval));
          }
          if (!interval && row.range.text) {
            addIssue(
              rowAssignments.length ? 'warning' : 'info',
              'UNRESOLVED_RANGE',
              `לא ניתן לזהות טווח תאריכים ושעות מהטקסט "${row.range.text}" — השיבוצים בשורה זו לא ייכללו בחיפוש לפי שעה.`,
              [ref(block.sheet, row.range.addr)],
              rowAssignments.map((a) => a.id),
            );
          }
        }
        continue;
      }

      // Day blocks
      let prevDate = null;
      let prevDayKey = null;
      let prevGroupMerged = false;
      let groupDate = null;
      let groupSpansNextDay = false;
      for (const row of block.rows) {
        const day = row.day;
        const isSlave = Boolean(day.masterAddr);
        const dayKey = day.text;
        const sameGroup = isSlave || (dayKey && dayKey === prevDayKey && !day.merged && !prevGroupMerged);
        if (!sameGroup) {
          groupDate = null;
          prevGroupMerged = day.merged;
          prevDayKey = dayKey;
          const parsed = day.text ? parseDayLabel(day.text) : null;
          groupSpansNextDay = parsed?.toWeekday !== undefined;
          if (!day.text) {
            addIssue('error', 'MISSING_DAY', 'חסר יום בשורה — לא ניתן לשייך את השיבוצים לתאריך.', [ref(block.sheet, day.addr)]);
          } else if (!parsed) {
            addIssue('error', 'INVALID_DAY', `הערך "${day.text}" אינו שם יום מוכר.`, [ref(block.sheet, day.addr)]);
          } else if (parsed.day) {
            groupDate = resolveYear(parsed, yearRef);
            if (!groupDate) {
              addIssue('error', 'WEEKDAY_MISMATCH', `התאריך ${parsed.day}/${parsed.month} אינו חל ביום ${HEBREW_DAYS[parsed.weekday]} בשנים הסמוכות — לא נקבע תאריך.`, [ref(block.sheet, day.addr)]);
            }
          } else if (prevDate) {
            groupDate = nextWeekdayOnOrAfter(addDays(prevDate, 1), parsed.weekday);
          } else if (weekStart) {
            groupDate = nextWeekdayOnOrAfter(weekStart, parsed.weekday);
          } else {
            missingWeekStartCells.push(ref(block.sheet, day.addr));
          }
          if (groupDate && prevDate) {
            const gap = dayNumber(groupDate) - dayNumber(prevDate);
            if (gap <= 0) {
              addIssue('warning', 'DAY_ORDER', `היום "${day.text}" מופיע אחרי יום מאוחר יותר בטבלה "${section.label ?? ''}".`, [ref(block.sheet, day.addr)]);
            } else if (gap > 1) {
              addIssue('info', 'DAY_GAP', `בטבלה "${section.label ?? ''}" יש דילוג של ${gap - 1} ימים לפני "${day.text}".`, [ref(block.sheet, day.addr)]);
            }
          }
          if (groupDate) prevDate = groupDate;
        }

        let interval = null;
        let rowKind = 'unresolved';
        const hasPeople = row.persons.some((p) => p.text);
        if (groupDate && block.hasTime) {
          if (!row.time.text) {
            if (hasPeople) addIssue('error', 'MISSING_TIME', 'חסרות שעות בשורה שיש בה שיבוצים.', [ref(block.sheet, row.time.addr)]);
          } else {
            let tr = parseTimeRange(row.time.text);
            // "ראשון - שני": the shift ends on the second day at its end time.
            if (groupSpansNextDay && (!tr.error || tr.error === 'zero-duration')) {
              const [from, to] = row.time.text.split(/\s*[-\u2013\u2014]\s*/).map(parseTimeOfDay);
              tr = { startMin: from, durationMin: to + 1440 - from };
            }
            // A bad time on a row with no names is only an empty line — nothing to report.
            if (tr.error && !hasPeople) {
              /* no assignment, no slot */
            } else if (tr.error === 'zero-duration') {
              addIssue('error', 'ZERO_DURATION', `משך המשמרת "${row.time.text}" הוא אפס.`, [ref(block.sheet, row.time.addr)]);
            } else if (tr.error) {
              addIssue('error', 'INVALID_TIME', `לא ניתן לפענח את השעות "${row.time.text}".`, [ref(block.sheet, row.time.addr)]);
            } else {
              const startKey = minuteKey(groupDate, tr.startMin);
              interval = { date: groupDate, startKey, endKey: startKey + tr.durationMin };
              rowKind = 'timed';
            }
          }
        } else if (groupDate && !block.hasTime) {
          // No hours column → whole-day duty on that date.
          const startKey = minuteKey(groupDate, 0);
          interval = { date: groupDate, startKey, endKey: startKey + 1440, allDay: true };
          rowKind = 'timed';
        }

        for (const person of row.persons) {
          const { position, positionKey } = positionOf(row, person);
          if (!person.text) {
            if (interval) slots.push(makeSlot(block, section, position, positionKey, person, interval, row));
            continue;
          }
          // A name with no task is not an assignment (ignored, noted for transparency).
          if (position === null) {
            addIssue('info', 'MISSING_TASK', `"${person.text}" רשום ללא משימה — לא נכלל בשיבוץ.`, [ref(block.sheet, person.addr)]);
            continue;
          }
          if (isMergedRepeat(person, positionKey, interval)) continue;
          addCell(base(row, person), position, positionKey, person, rowKind, interval);
        }
      }
    }
  }

  // ---- 3. Newer tab wins --------------------------------------------------------------------
  // When two tabs cover the same post at overlapping times (e.g. the handover Sunday appears in
  // both weeks), the tab with the later week start replaces the earlier one for that post/time.
  if (multiSheet) {
    const rank = new Map(weekStarts.map((w, i) => [w.sheet, [w.date ?? '', i]]));
    const newer = (a, b) => {
      const [da, ia] = rank.get(a);
      const [db, ib] = rank.get(b);
      return da > db || (da === db && ia > ib);
    };
    const sheetOf = (x) => x.sheet ?? x.cell.split('!')[0];
    const timedItems = [...assignments.filter((a) => a.kind === 'timed'), ...slots.filter((x) => x.startKey !== null)];
    const replacedBy = (x) =>
      timedItems.find(
        (y) => y !== x && sheetOf(y) !== sheetOf(x) && newer(sheetOf(y), sheetOf(x)) &&
          y.sectionKey === x.sectionKey && y.positionKey === x.positionKey && y.startKey < x.endKey && x.startKey < y.endKey,
      );
    const dropped = new Set();
    for (const a of assignments) {
      if (a.kind !== 'timed') continue;
      const by = replacedBy(a);
      if (!by) continue;
      dropped.add(a.id);
      const who = by.person ?? by.soldier ?? 'משבצת ריקה';
      addIssue('info', 'SUPERSEDED', `"${a.soldier}" (${a.section} / ${a.position}, ${a.start.date.slice(8)}/${a.start.date.slice(5, 7)} ${a.start.time}) הוחלף בשיבוץ מהלשונית "${sheetOf(by)}" (${who}).`, [ref(a.sheet, a.source.cell)]);
    }
    const keptSlots = slots.filter((x) => x.startKey === null || !replacedBy(x));
    slots.splice(0, slots.length, ...keptSlots);
    const kept = assignments.filter((a) => !dropped.has(a.id));
    assignments.splice(0, assignments.length, ...kept);
    for (const issue of issues) issue.assignmentIds = issue.assignmentIds.filter((id) => !dropped.has(id));
  }

  if (missingWeekStartCells.length) {
    addIssue('error', 'NO_WEEK_START', 'לא נמצא בקובץ תאריך מפורש, ולכן לא ניתן לקבוע תאריכים לימים. יש לבחור את תאריך תחילת השבוע.', missingWeekStartCells.slice(0, 5));
  }

  for (const { sheet, unparsedRegions, hidden } of sheetResults) {
    if (hidden) addIssue('info', 'HIDDEN_SHEET', `הגיליון "${sheet}" מוסתר ולא נסרק.`);
    for (const region of unparsedRegions || []) {
      addIssue(
        'info',
        'UNPARSED_REGION',
        `אזור ${region.range} (${region.count} תאים, למשל: ${region.sample.join(', ')}) אינו טבלה עם משימה ושעות — לא נכלל בשיבוץ.`,
        [ref(sheet, region.range)],
      );
    }
  }

  return {
    // weekStart/detectedWeekStart describe the first sheet (single-sheet workbooks); weekStarts has every sheet.
    weekStart: weekStarts[0]?.date ? (({ detected, sheet, ...w }) => w)(weekStarts[0]) : null,
    detectedWeekStart: weekStarts.find((w) => w.detected)?.detected ?? null,
    weekStarts: weekStarts.map(({ detected, ...w }) => w),
    sections: sections.map(({ key, label, positions }) => ({ key, label, positions })),
    assignments,
    slots,
    issues,
  };
}

// sheet name → { firstDate, cell, text }: the earliest explicit date in each sheet.
export function detectFirstDates(sheetResults, today) {
  const ref = (sheet, addr) => `${sheet}!${addr}`;
  const detectedBySheet = new Map();
  for (const { blocks } of sheetResults) {
    for (const block of blocks) {
      for (const row of block.rows) {
        const candidates = [];
        if (row.day?.text && !row.day.masterAddr) {
          const p = parseDayLabel(row.day.text);
          if (p?.day) candidates.push({ p, text: row.day.text, addr: row.day.addr });
        }
        if (row.range?.text) {
          const rg = parseRangeText(row.range.text);
          if (rg) candidates.push({ p: rg.from, text: row.range.text, addr: row.range.addr });
        }
        for (const c of candidates) {
          const iso = resolveYear(c.p, today);
          const prev = detectedBySheet.get(block.sheet);
          if (iso && (!prev || iso < prev.firstDate)) {
            detectedBySheet.set(block.sheet, { firstDate: iso, cell: ref(block.sheet, c.addr), text: c.text });
          }
        }
      }
    }
  }
  return detectedBySheet;
}

function makeAssignment(list, base, position, positionKey, name, kind, interval) {
  const a = {
    id: `a${list.length + 1}`,
    ...base,
    position,
    positionKey,
    soldier: name,
    soldierKey: matchKey(name),
    kind,
    date: interval?.date || null,
    startKey: kind === 'timed' ? interval.startKey : null,
    endKey: kind === 'timed' ? interval.endKey : null,
    allDay: Boolean(interval?.allDay),
  };
  a.start = a.startKey !== null ? keyToParts(a.startKey) : null;
  a.end = a.endKey !== null ? keyToParts(a.endKey) : null;
  list.push(a);
  return a;
}

function makeSlot(block, section, position, positionKey, person, interval, row) {
  return {
    section: section.label,
    sectionKey: section.key,
    position,
    positionKey,
    date: interval.date,
    startKey: interval.startKey,
    endKey: interval.endKey,
    allDay: Boolean(interval.allDay),
    start: interval.startKey !== null ? keyToParts(interval.startKey) : null,
    end: interval.endKey !== null ? keyToParts(interval.endKey) : null,
    cell: `${block.sheet}!${person.addr}`,
    row: row.r,
  };
}

// "ראשון 11/10 00:00 – שלישי 13/10 11:00" → { from, to } each { weekday, day, month, minutes }.
// Anything less specific returns null (left unresolved).
export function parseRangeText(text) {
  const parts = text.split(/\s+עד\s+|\s*[-–—]\s*/);
  if (parts.length !== 2) return null;
  const side = (s) => {
    const m = /^(\S+)\s+(\d{1,2}[./]\d{1,2}(?:[./]\d{2,4})?)\s+(\d{1,2}:\d{2})$/.exec(s.trim());
    if (!m) return null;
    const d = parseDayLabel(`${m[1]} ${m[2]}`);
    const minutes = parseTimeOfDay(m[3]);
    if (!d?.day || minutes === null || minutes === 1440) return null;
    return { ...d, minutes };
  };
  const from = side(parts[0]);
  const to = side(parts[1]);
  return from && to ? { from, to } : null;
}

const dm = (iso) => `${iso.slice(8)}/${iso.slice(5, 7)}`;

// "שלישי עד ראשון" (day names only) directly after a row that ended at <prevEnd>: starts at prevEnd
// (its start day must match), ends on the next occurrence of the named day at the same clock time.
// Day names tolerate doubled ו/י spelling ("ראשוון"). Anything else → null (unresolved).
export function continueRange(text, prevEndKey) {
  const parts = text.split(/\s+עד\s+|\s*[-\u2013\u2014]\s*/);
  if (parts.length !== 2) return null;
  const from = dayNameIndex(parts[0]);
  const to = dayNameIndex(parts[1]);
  if (from < 0 || to < 0) return null;
  const start = keyToParts(prevEndKey);
  if (weekdayOf(start.date) !== from) return null;
  const endDate = nextWeekdayOnOrAfter(addDays(start.date, 1), to);
  const endKey = minuteKey(endDate, prevEndKey - minuteKey(start.date, 0));
  return { date: start.date, startKey: prevEndKey, endKey };
}

function dayNameIndex(word) {
  const w = word.trim().replace(/^יום\s+/, '');
  const exact = HEBREW_DAYS.indexOf(w);
  if (exact >= 0) return exact;
  return HEBREW_DAYS.indexOf(w.replace(/וו/g, 'ו').replace(/יי/g, 'י'));
}

// A person cell may name several soldiers ("א/ב") and carry a note in parentheses ("א(הערה)").
// Returns [{ name, note? }]; names keep their source spelling (whitespace-cleaned).
export function splitCell(text) {
  return text
    .split('/')
    .map((part) => {
      const notes = [];
      const name = part.replace(/\(([^)]*)\)/g, (_, n) => (notes.push(n.trim()), ' ')).replace(/\s+/g, ' ').trim();
      return name ? { name, ...(notes.filter(Boolean).length ? { note: notes.filter(Boolean).join(', ') } : {}) } : null;
    })
    .filter(Boolean);
}
