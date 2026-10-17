// "לוח שבועי": posts × days duty board built from the shared core (week.js), entirely client-side
// over the roster already loaded — no separate data source.
import { HEBREW_DAYS, addDays, todayIso, weekdayOf } from '/core/dates.js';
import { buildWeekBoard, entryTimeLabel, weekStartOf } from '/core/week.js';
import { formatLong } from './datepicker.js';
import { cellChip, cellNotes, dayMonth, el, fillPostSelect, ltr, nightText } from './ui.js';

const $ = (id) => document.getElementById(id);
const WARN_CODES = new Set(['OVERLAP', 'DUPLICATE']);

export function createWeekView({ onShowSoldier, onSearchDay }) {
  let roster = null;
  let weekStart = null;
  let byId = new Map();
  let issuesByAssignment = new Map();
  let selectedId = null;

  const rosterWeek = () => weekStartOf(roster.dateRange?.from ?? todayIso());
  const coversWeek = (ws) => roster.dateRange && roster.dateRange.from <= addDays(ws, 6) && roster.dateRange.to >= ws;

  function render() {
    const board = buildWeekBoard(roster, weekStart, $('week-post').value || 'all');
    const days = board.days;
    $('week-title').replaceChildren('השבוע ', ltr(dayMonth(days[0])), ' עד ', ltr(`${dayMonth(days[6])}/${days[6].slice(0, 4)}`));

    const q = $('week-person').value.trim();
    // A soldier matches when any of their spellings matches; then all their shifts are highlighted.
    const wanted = new Set(q ? roster.assignments.filter((a) => a.person.includes(q) || a.soldier.includes(q)).map((a) => a.personKey) : []);
    const isHit = (e) => q && e.type === 'assignment' && wanted.has(e.personKey);
    let hits = 0;

    const status = [];
    if (!board.assignmentCount) status.push(coversWeek(weekStart) ? 'אין שיבוצים בעמדה שנבחרה בשבוע זה.' : 'אין בקובץ שיבוצים בשבוע זה.');
    else status.push(`${board.assignmentCount} שיבוצים בשבוע זה.`);
    if (board.hiddenRows) status.push(`${board.hiddenRows} עמדות ללא שיבוצים בשבוע זה מוסתרות.`);

    const today = todayIso();
    const head = el(
      'tr',
      {},
      el('th', { scope: 'col', class: 'board-corner' }, 'עמדה / תפקיד'),
      ...days.map((d) => {
        const btn = el('button', { type: 'button', class: 'day-head', title: `חיפוש לפי שעה ב${formatLong(d)}` }, el('span', {}, HEBREW_DAYS[weekdayOf(d)]), ltr(dayMonth(d)));
        btn.addEventListener('click', () => onSearchDay(d));
        return el('th', { scope: 'col', class: d === today ? 'is-today' : '' }, btn);
      }),
    );

    const body = el('tbody');
    for (const section of board.sections) {
      body.append(el('tr', { class: 'board-section' }, el('th', { scope: 'rowgroup', colspan: '8' }, section.label ?? 'ללא כותרת')));
      for (const row of section.rows) {
        const tr = el('tr', {}, el('th', { scope: 'row', class: 'board-pos' }, row.label));
        row.cells.forEach((entries, i) => {
          const td = el('td', { class: days[i] === today ? 'is-today' : '' });
          for (const e of entries) {
            if (e.type === 'empty') {
              td.append(el('div', { class: 'entry entry-empty' }, el('span', { class: 'entry-time' }, entryTimeLabel(e)), el('span', {}, 'ריק בקובץ')));
              continue;
            }
            const classes = ['entry'];
            if (!e.startsToday) classes.push('entry-cont');
            if ((issuesByAssignment.get(e.id) || []).some((iss) => WARN_CODES.has(iss.code))) classes.push('entry-warn');
            if (q) classes.push(isHit(e) ? 'entry-hit' : 'entry-dim');
            if (e.id === selectedId) classes.push('entry-selected');
            if (isHit(e)) hits++;
            const btn = el('button', { type: 'button', class: classes.join(' '), 'data-id': e.id }, el('span', { class: 'entry-time' }, entryTimeLabel(e)));
            if (e.startsToday && nightText(e)) btn.append(el('span', { class: 'night' }, nightText(e)));
            btn.append(el('span', { class: 'entry-name' }, e.person));
            btn.addEventListener('click', () => select(e.id));
            td.append(btn);
          }
          tr.append(td);
        });
        body.append(tr);
      }
    }
    if (q) status.push(hits ? `מודגשים ${hits} שיבוצים התואמים ל"${q}".` : `לא נמצאו בשבוע זה שיבוצים התואמים ל"${q}".`);
    if (board.undetermined.length) status.push(`${board.undetermined.length} שיבוצים ללא זמן מזוהה אינם מוצגים בלוח.`);
    $('week-status').textContent = status.join(' ');

    $('week-board').replaceChildren(
      board.sections.length
        ? el('table', { class: 'board' }, el('thead', {}, head), body)
        : el('p', { class: 'empty' }, coversWeek(weekStart) ? 'אין שיבוצים להצגה בשבוע זה.' : 'השבוע שנבחר מחוץ לטווח השיבוץ שבקובץ. אפשר לחזור ל"שבוע השיבוץ".'),
    );
  }

  function select(id) {
    selectedId = id;
    render();
    const a = byId.get(id);
    const range = a.allDay
      ? `${formatLong(a.start.date)}, כל היום`
      : `${formatLong(a.start.date)} ${a.start.time} עד ${a.end.date === a.start.date ? '' : `${formatLong(a.end.date)} `}${a.end.time}`;
    const parts = [
      el('h3', {}, a.person),
      el('p', {}, `${a.section ?? 'ללא כותרת'} › ${a.position}`),
      el('p', {}, range),
    ];
    if (nightText(a)) parts.push(el('p', { class: 'night' }, `לילה ${nightText(a)}`));
    parts.push(...cellNotes(a));
    const src = el('p', { class: 'muted' }, 'מקור: ', cellChip(`${a.source.sheet}!${a.source.cell}`));
    if (a.source.timeText) src.append(' · ', a.source.dayText ? `${a.source.dayText} ` : '', ltr(a.source.timeText));
    parts.push(src);
    for (const issue of (issuesByAssignment.get(id) || []).filter((i) => i.level !== 'info')) {
      parts.push(el('p', { class: `inline-issue inline-${issue.level}` }, `⚠ ${issue.message}`));
    }
    const toSoldier = el('button', { type: 'button', class: 'btn' }, `כל השיבוצים של ${a.person}`);
    toSoldier.addEventListener('click', () => onShowSoldier(a.personKey));
    const close = el('button', { type: 'button', class: 'btn' }, 'סגירה');
    close.addEventListener('click', () => {
      selectedId = null;
      $('week-detail').replaceChildren();
      render();
    });
    parts.push(el('div', { class: 'row-actions' }, toSoldier, close));
    $('week-detail').replaceChildren(el('div', { class: 'detail-card' }, ...parts));
  }

  const go = (ws) => {
    weekStart = ws;
    selectedId = null;
    $('week-detail').replaceChildren();
    render();
  };
  $('week-prev').addEventListener('click', () => go(addDays(weekStart, -7)));
  $('week-next').addEventListener('click', () => go(addDays(weekStart, 7)));
  $('week-today').addEventListener('click', () => go(weekStartOf(todayIso())));
  $('week-roster').addEventListener('click', () => go(rosterWeek()));
  $('week-post').addEventListener('change', () => roster && render());
  $('week-person').addEventListener('input', () => roster && render());

  return {
    setRoster(next) {
      roster = next;
      selectedId = null;
      $('week-detail').replaceChildren();
      $('week-person').value = '';
      if (!roster) {
        $('week-body').hidden = true;
        $('week-empty').hidden = false;
        return;
      }
      byId = new Map(roster.assignments.map((a) => [a.id, a]));
      issuesByAssignment = new Map();
      for (const issue of roster.issues) {
        for (const id of issue.assignmentIds) {
          if (!issuesByAssignment.has(id)) issuesByAssignment.set(id, []);
          issuesByAssignment.get(id).push(issue);
        }
      }
      fillPostSelect($('week-post'), roster.options);
      const current = weekStartOf(todayIso());
      weekStart = coversWeek(current) ? current : rosterWeek();
      $('week-body').hidden = false;
      $('week-empty').hidden = true;
      render();
    },
  };
}
