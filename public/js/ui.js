// Shared DOM helpers. All roster text is inserted as text nodes — never as HTML.
import { addDays, nightBetween } from '/core/dates.js';

export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  node.append(...children);
  return node;
}

export const dayMonth = (iso) => `${iso.slice(8)}/${iso.slice(5, 7)}`;
export const shortDate = (iso) => `${iso.slice(8)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;

// Times/dates are LTR runs inside RTL text; each is isolated so ranges never render reversed.
export const ltr = (text) => el('bdi', { dir: 'ltr' }, text);

// "בין יום חמישי לשישי" for night shifts (00:00–06:00 start), else null.
export function nightText(x) {
  const n = nightBetween(x);
  return n ? `בין יום ${n.fromDay} ל${n.toDay}` : null;
}

export function shiftNode(x) {
  const span = el('span', { class: 'shift' });
  if (!x.start) {
    span.append('ללא שעה');
    return span;
  }
  if (x.allDay) {
    span.append('כל היום');
    return span;
  }
  const endsAtMidnight = x.end.time === '00:00' && addDays(x.start.date, 1) === x.end.date;
  if (x.end.date === x.start.date || endsAtMidnight) {
    span.append(ltr(`${x.start.time}–${endsAtMidnight ? '24:00' : x.end.time}`));
    const night = nightText(x);
    if (night) span.append(el('div', { class: 'night' }, night));
  } else {
    span.append(ltr(`${dayMonth(x.start.date)} ${x.start.time}`), ' עד ', ltr(`${dayMonth(x.end.date)} ${x.end.time}`));
  }
  return span;
}

// "שיבוץ!C39" → sheet name in RTL, cell address isolated as LTR (avoids bidi scrambling).
export function cellChip(ref) {
  const i = ref.lastIndexOf('!');
  const chip = el('code', { class: 'cell' });
  if (i > 0) chip.append(`${ref.slice(0, i)} · `);
  chip.append(ltr(i > 0 ? ref.slice(i + 1) : ref));
  return chip;
}

// What the source cell said, when it differs from the soldier's merged name.
export function cellNotes(a) {
  const notes = [];
  const written = a.source.cellText ?? a.soldier;
  if (written !== a.person) notes.push(el('div', { class: 'muted small' }, `בקובץ: "${written}"`));
  if (a.sharedWith?.length) notes.push(el('div', { class: 'muted small' }, `תא משותף עם: ${a.sharedWith.join(', ')}`));
  if (a.note) notes.push(el('div', { class: 'muted small' }, `הערה בתא: ${a.note}`));
  return notes;
}

// columns: which leading columns to show; the soldier view drops "חייל" and adds "תאריך".
export function assignmentTable(list, issuesByAssignment, { soldierColumn = true, dateColumn = false } = {}) {
  const cols = [soldierColumn && 'חייל', dateColumn && 'תאריך', 'טבלה', 'עמדה / תפקיד', 'משמרת', 'מקור'].filter(Boolean);
  const head = el('tr', {}, ...cols.map((t) => el('th', { scope: 'col' }, t)));
  const rows = list.map((a) => {
    const cells = [];
    const warnings = (issuesByAssignment.get(a.id) || []).filter((i) => i.level !== 'info');
    if (soldierColumn) {
      const nameCell = el('td', {}, el('strong', {}, a.person));
      nameCell.append(...cellNotes(a));
      for (const issue of warnings) nameCell.append(el('div', { class: `inline-issue inline-${issue.level}` }, `⚠ ${issue.message}`));
      cells.push(nameCell);
    }
    if (dateColumn) {
      const dateCell = el('td', { 'data-label': 'תאריך' }, el('strong', {}, a.start ? ltr(dayMonth(a.start.date)) : 'לא זוהה'));
      if (a.start) dateCell.append(' ', el('span', { class: 'muted' }, a.source.dayText?.split(' ')[0] ?? ''));
      if (!soldierColumn) dateCell.append(...cellNotes(a));
      if (!soldierColumn) for (const issue of warnings) dateCell.append(el('div', { class: `inline-issue inline-${issue.level}` }, `⚠ ${issue.message}`));
      cells.push(dateCell);
    }
    const when = a.kind === 'timed' ? shiftNode(a) : a.source.timeText ? `"${a.source.timeText}" (לא זוהה)` : 'לא זוהה';
    const src = el('td', { 'data-label': 'מקור' }, cellChip(`${a.source.sheet}!${a.source.cell}`));
    if (a.source.timeText && a.kind === 'timed') {
      src.append(el('div', { class: 'muted small' }, 'בקובץ: ', a.source.dayText ? `${a.source.dayText} ` : '', ltr(a.source.timeText)));
    }
    cells.push(
      el('td', { 'data-label': 'טבלה' }, a.section ?? 'ללא כותרת'),
      el('td', { 'data-label': 'עמדה / תפקיד' }, a.position ?? '—'),
      el('td', { 'data-label': 'משמרת' }, when),
      src,
    );
    return el('tr', {}, ...cells);
  });
  return el('div', { class: 'table-wrap' }, el('table', { class: 'results' }, el('thead', {}, head), el('tbody', {}, ...rows)));
}

// Post/role <select>, filled only from this roster's options (previous options are discarded).
export function fillPostSelect(select, options) {
  select.replaceChildren();
  if (!options.length) {
    select.append(el('option', { value: '' }, 'לא נמצאו עמדות או תפקידים בקובץ'));
    select.disabled = true;
    return;
  }
  select.disabled = false;
  select.append(el('option', { value: 'all' }, 'כל העמדות והתפקידים'));
  for (const g of options) {
    const name = g.label ?? 'ללא כותרת';
    const group = el('optgroup', { label: name });
    group.append(el('option', { value: g.id }, `${name} — כל התפקידים`));
    for (const p of g.positions) group.append(el('option', { value: p.id }, `${name} › ${p.label}`));
    select.append(group);
  }
  select.value = 'all';
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = el('textarea', { readonly: '', style: 'position:fixed;opacity:0' });
    ta.value = text;
    document.body.append(ta);
    ta.select();
    const ok = document.execCommand?.('copy') ?? false;
    ta.remove();
    return ok;
  }
}
