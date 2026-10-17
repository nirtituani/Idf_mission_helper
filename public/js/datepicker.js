// Custom RTL Hebrew date picker: a field button that opens a monthly calendar popover.
import { addDays, isIsoDate, makeIso, weekdayOf } from '/core/dates.js';

export const WEEKDAY_SHORT = ['א׳', 'ב׳', 'ג׳', 'ד׳', 'ה׳', 'ו׳', 'ש׳'];
const WEEKDAY_LONG = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];

// 6 weeks × 7 days, Sunday first. month is 1–12.
export function monthGrid(year, month) {
  const first = makeIso(year, month, 1);
  const start = addDays(first, -weekdayOf(first));
  return Array.from({ length: 42 }, (_, i) => {
    const iso = addDays(start, i);
    return { iso, day: Number(iso.slice(8)), inMonth: Number(iso.slice(5, 7)) === month };
  });
}

export function shiftMonth(year, month, delta) {
  const idx = year * 12 + (month - 1) + delta;
  return { year: Math.floor(idx / 12), month: (idx % 12) + 1 };
}

const utc = (iso) => new Date(`${iso}T00:00:00Z`);
export function formatLong(iso) {
  return new Intl.DateTimeFormat('he-IL', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(utc(iso));
}
export function monthLabel(year, month) {
  return new Intl.DateTimeFormat('he-IL', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(utc(makeIso(year, month, 1)));
}

let pickerCount = 0;

export class DatePicker {
  constructor(container, { value, today, onChange = () => {}, markedDates = new Set(), label = 'תאריך' }) {
    this.today = today;
    this.value = isIsoDate(value) ? value : today;
    this.onChange = onChange;
    this.marked = markedDates;
    this.id = `dp${++pickerCount}`;
    this.view = { year: Number(this.value.slice(0, 4)), month: Number(this.value.slice(5, 7)) };
    this.focusIso = this.value;

    this.root = el('div', { class: 'dp' });
    this.field = el('button', { type: 'button', class: 'dp-field', 'aria-haspopup': 'dialog', 'aria-expanded': 'false', 'aria-controls': `${this.id}-pop`, 'aria-label': `${label}: ` });
    this.fieldText = el('span', { class: 'dp-value' });
    this.field.append(el('span', { class: 'dp-icon', 'aria-hidden': 'true' }, '📅'), this.fieldText);

    this.pop = el('div', { class: 'dp-pop', id: `${this.id}-pop`, role: 'dialog', 'aria-label': `בחירת ${label}`, hidden: '' });
    this.prevBtn = el('button', { type: 'button', class: 'dp-nav', 'aria-label': 'חודש קודם' }, '›');
    this.nextBtn = el('button', { type: 'button', class: 'dp-nav', 'aria-label': 'חודש הבא' }, '‹');
    this.monthEl = el('div', { class: 'dp-month', 'aria-live': 'polite' });
    this.grid = el('table', { class: 'dp-grid', role: 'grid' });
    this.todayBtn = el('button', { type: 'button', class: 'dp-today' }, 'היום');
    this.closeBtn = el('button', { type: 'button', class: 'dp-close' }, 'סגירה');
    this.pop.append(
      el('div', { class: 'dp-head' }, this.prevBtn, this.monthEl, this.nextBtn),
      this.grid,
      el('div', { class: 'dp-foot' }, this.todayBtn, this.closeBtn),
    );
    this.root.append(this.field, this.pop);
    container.replaceChildren(this.root);

    this.field.addEventListener('click', () => (this.isOpen() ? this.close() : this.open()));
    this.prevBtn.addEventListener('click', () => this.moveMonth(-1));
    this.nextBtn.addEventListener('click', () => this.moveMonth(1));
    this.todayBtn.addEventListener('click', () => this.select(this.today));
    this.closeBtn.addEventListener('click', () => this.close(true));
    this.grid.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-iso]');
      if (btn) this.select(btn.dataset.iso);
    });
    this.grid.addEventListener('keydown', (e) => this.onKey(e));
    this.pop.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        this.close(true);
      }
    });
    this.outside = (e) => {
      if (this.isOpen() && !this.root.contains(e.target)) this.close();
    };
    this.root.ownerDocument.addEventListener('mousedown', this.outside);
    this.renderField();
  }

  destroy() {
    this.root.ownerDocument.removeEventListener('mousedown', this.outside);
    this.root.remove();
  }

  isOpen() {
    return !this.pop.hidden;
  }

  open() {
    this.view = { year: Number(this.value.slice(0, 4)), month: Number(this.value.slice(5, 7)) };
    this.focusIso = this.value;
    this.pop.hidden = false;
    this.field.setAttribute('aria-expanded', 'true');
    this.renderGrid();
    this.focusDay();
  }

  close(returnFocus = false) {
    this.pop.hidden = true;
    this.field.setAttribute('aria-expanded', 'false');
    if (returnFocus) this.field.focus();
  }

  setValue(iso) {
    if (!isIsoDate(iso)) return;
    this.value = iso;
    this.renderField();
    if (this.isOpen()) this.renderGrid();
  }

  setMarked(set) {
    this.marked = set;
    if (this.isOpen()) this.renderGrid();
  }

  select(iso) {
    this.setValue(iso);
    this.close(true);
    this.onChange(iso);
  }

  moveMonth(delta) {
    this.view = shiftMonth(this.view.year, this.view.month, delta);
    this.focusIso = makeIso(this.view.year, this.view.month, 1);
    this.renderGrid();
  }

  onKey(e) {
    // RTL: the visual "left" is the next day.
    const steps = { ArrowLeft: 1, ArrowRight: -1, ArrowDown: 7, ArrowUp: -7 };
    let next = null;
    if (e.key in steps) next = addDays(this.focusIso, steps[e.key]);
    else if (e.key === 'Home') next = addDays(this.focusIso, -weekdayOf(this.focusIso));
    else if (e.key === 'End') next = addDays(this.focusIso, 6 - weekdayOf(this.focusIso));
    else if (e.key === 'PageUp' || e.key === 'PageDown') {
      const m = shiftMonth(Number(this.focusIso.slice(0, 4)), Number(this.focusIso.slice(5, 7)), e.key === 'PageUp' ? -1 : 1);
      const day = Math.min(Number(this.focusIso.slice(8)), 28);
      next = makeIso(m.year, m.month, day);
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      this.select(this.focusIso);
      return;
    }
    if (!next) return;
    e.preventDefault();
    this.focusIso = next;
    this.view = { year: Number(next.slice(0, 4)), month: Number(next.slice(5, 7)) };
    this.renderGrid();
    this.focusDay();
  }

  focusDay() {
    this.grid.querySelector(`button[data-iso="${this.focusIso}"]`)?.focus();
  }

  renderField() {
    this.fieldText.textContent = formatLong(this.value);
    this.field.setAttribute('aria-label', `${this.field.getAttribute('aria-label').split(':')[0]}: ${formatLong(this.value)}`);
  }

  renderGrid() {
    this.monthEl.textContent = monthLabel(this.view.year, this.view.month);
    const head = el('tr', {}, ...WEEKDAY_SHORT.map((d, i) => el('th', { scope: 'col', abbr: WEEKDAY_LONG[i] }, d)));
    const cells = monthGrid(this.view.year, this.view.month);
    if (!cells.some((c) => c.iso === this.focusIso)) this.focusIso = makeIso(this.view.year, this.view.month, 1);
    const body = el('tbody');
    for (let w = 0; w < 6; w++) {
      const tr = el('tr');
      for (const c of cells.slice(w * 7, w * 7 + 7)) {
        const classes = ['dp-day'];
        if (!c.inMonth) classes.push('dp-out');
        if (c.iso === this.value) classes.push('dp-selected');
        if (c.iso === this.today) classes.push('dp-is-today');
        if (this.marked.has(c.iso)) classes.push('dp-has-data');
        const btn = el('button', {
          type: 'button',
          class: classes.join(' '),
          'data-iso': c.iso,
          tabindex: c.iso === this.focusIso ? '0' : '-1',
          'aria-label': formatLong(c.iso) + (c.iso === this.today ? ' (היום)' : '') + (this.marked.has(c.iso) ? ' — יש שיבוצים' : ''),
          'aria-pressed': c.iso === this.value ? 'true' : 'false',
        }, String(c.day));
        tr.append(el('td', { role: 'gridcell' }, btn));
      }
      body.append(tr);
    }
    this.grid.replaceChildren(el('thead', {}, head), body);
  }
}

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  node.append(...children);
  return node;
}
