// "חיפוש משמרות": optional day / hour / post / soldier filters, live results.
import { HEBREW_DAYS, weekdayOf } from '/core/dates.js';
import { findShifts, rosterDays } from '/core/shifts.js';
import { assignmentTable, cellChip, dayMonth, el, fillPostSelect, shiftNode } from './ui.js';

const $ = (id) => document.getElementById(id);

export function createShiftsView() {
  let roster = null;
  let issuesByAssignment = new Map();

  const hour = $('sh-hour');
  hour.append(el('option', { value: '' }, 'כל השעות'));
  for (let h = 0; h < 24; h++) hour.append(el('option', { value: String(h) }, `${String(h).padStart(2, '0')}:00`));

  function render() {
    const query = {
      date: $('sh-day').value || null,
      hour: hour.value === '' ? null : Number(hour.value),
      postId: $('sh-post').value || 'all',
      soldier: $('sh-soldier').value,
    };
    const res = findShifts(roster, query);
    const includeEmpty = $('sh-empty').checked;
    const out = [];
    const people = new Set(res.shifts.map((a) => a.personKey)).size;
    out.push(
      el(
        'p',
        { class: res.shifts.length ? 'status status-ok' : 'status status-warn' },
        res.shifts.length ? `נמצאו ${res.shifts.length} משמרות של ${people} חיילים.` : 'לא נמצאו בקובץ משמרות התואמות לחיפוש.',
      ),
    );
    if (res.shifts.length) out.push(assignmentTable(res.shifts, issuesByAssignment, { dateColumn: true }));
    if (includeEmpty && res.emptySlots.length) {
      out.push(
        el('h4', {}, `משבצות ריקות בקובץ (${res.emptySlots.length})`),
        el(
          'ul',
          { class: 'plain' },
          ...res.emptySlots.map((s) => el('li', {}, `${dayMonth(s.start.date)} · `, shiftNode(s), ` · ${s.section ?? 'ללא כותרת'} › ${s.position ?? '—'} · `, cellChip(s.cell))),
        ),
      );
    }
    $('sh-results').replaceChildren(...out);
  }

  for (const id of ['sh-day', 'sh-hour', 'sh-post', 'sh-empty']) $(id).addEventListener('change', () => roster && render());
  $('sh-soldier').addEventListener('input', () => roster && render());
  $('sh-reset').addEventListener('click', () => {
    $('sh-day').value = '';
    hour.value = '';
    $('sh-post').value = 'all';
    $('sh-soldier').value = '';
    $('sh-empty').checked = false;
    render();
  });

  return {
    setRoster(next) {
      roster = next;
      if (!roster) {
        $('shifts-body').hidden = true;
        $('shifts-empty').hidden = false;
        return;
      }
      issuesByAssignment = new Map();
      for (const issue of roster.issues) {
        for (const id of issue.assignmentIds) {
          if (!issuesByAssignment.has(id)) issuesByAssignment.set(id, []);
          issuesByAssignment.get(id).push(issue);
        }
      }
      const day = $('sh-day');
      day.replaceChildren(el('option', { value: '' }, 'כל הימים'));
      for (const d of rosterDays(roster)) day.append(el('option', { value: d }, `${HEBREW_DAYS[weekdayOf(d)]} ${dayMonth(d)}`));
      fillPostSelect($('sh-post'), roster.options);
      hour.value = '';
      $('sh-soldier').value = '';
      $('shifts-body').hidden = false;
      $('shifts-empty').hidden = true;
      render();
    },
  };
}
