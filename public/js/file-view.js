// "הקובץ": the used tab shown as it is (text, merges, fill colours), so a problem or a warning can
// point at its cells. show() marks the issue's cells and scrolls to them; the rest is untouched.
import { columnName } from '/core/grid.js';
import { el } from './ui.js';

const $ = (id) => document.getElementById(id);

export function createFileView() {
  let roster = null;
  let owner = new Map(); // "r:c" → the <td> that shows it (a merged cell owns every position it covers)
  let marked = [];
  let at = 0;

  function render() {
    const g = roster?.grid;
    $('file-empty').hidden = Boolean(g);
    $('file-body').hidden = !g;
    $('file-focus').hidden = true;
    owner = new Map();
    marked = [];
    if (!g) return $('file-grid').replaceChildren();
    $('file-sheet').textContent = `לשונית: "${g.sheet}"`;
    const byPos = new Map(g.cells.map((x) => [`${x.r}:${x.c}`, x]));
    const covered = new Set();
    const head = el('tr', {}, el('th', { class: 'sheet-corner' }), ...Array.from({ length: g.cols }, (_, i) => el('th', { scope: 'col' }, columnName(i + 1))));
    const body = el('tbody');
    for (let r = 1; r <= g.rows; r++) {
      const tr = el('tr', {}, el('th', { scope: 'row' }, String(r)));
      for (let c = 1; c <= g.cols; c++) {
        const key = `${r}:${c}`;
        if (covered.has(key)) continue;
        const x = byPos.get(key);
        const td = el('td', {}, x?.text ?? '');
        if (x?.rs) td.rowSpan = x.rs;
        if (x?.cs) td.colSpan = x.cs;
        if (x?.fill) td.style.setProperty('--fill', x.fill);
        if (x?.bold) td.classList.add('b');
        if ((x?.text ?? '').length <= 14) td.classList.add('nw'); // short values ("14:00-22:00") stay on one line
        for (let dr = 0; dr < (x?.rs ?? 1); dr++) {
          for (let dc = 0; dc < (x?.cs ?? 1); dc++) {
            owner.set(`${r + dr}:${c + dc}`, td);
            if (dr || dc) covered.add(`${r + dr}:${c + dc}`);
          }
        }
        tr.append(td);
      }
      body.append(tr);
    }
    $('file-grid').replaceChildren(el('table', { class: 'sheet' }, el('thead', {}, head), body));
  }

  // "שיבוץ!C39" → the <td> showing it, or null when it is on another tab or outside the shown area.
  function cellOf(ref) {
    const i = ref.lastIndexOf('!');
    if (i > 0 && ref.slice(0, i) !== roster?.grid?.sheet) return null;
    const m = /^([A-Z]+)(\d+)$/.exec(ref.slice(i + 1));
    if (!m) return null;
    const c = [...m[1]].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0);
    return owner.get(`${m[2]}:${c}`) ?? null;
  }

  function clear() {
    for (const td of $('file-grid').querySelectorAll('.hl, .hl-ctx, .hl-at')) td.classList.remove('hl', 'hl-ctx', 'hl-at');
    marked = [];
    $('file-focus').hidden = true;
  }

  function go(i) {
    if (!marked.length) return;
    at = (i + marked.length) % marked.length;
    for (const td of marked) td.classList.toggle('hl-at', td === marked[at]);
    marked[at].scrollIntoView?.({ block: 'center', inline: 'center', behavior: 'smooth' });
    $('file-pos').textContent = marked.length > 1 ? `תא ${at + 1} מתוך ${marked.length}` : '';
  }

  // cells: the issue's own cells (the soldier cells); context: the day/hours cells of those rows.
  function show({ message = '', cells = [], context = [] }) {
    clear();
    marked = [...new Set(cells.map(cellOf).filter(Boolean))];
    for (const td of marked) td.classList.add('hl');
    for (const td of context.map(cellOf)) if (td && !marked.includes(td)) td.classList.add('hl-ctx');
    const missing = cells.length && !marked.length ? ' (התאים אינם בלשונית המוצגת)' : '';
    $('file-message').textContent = `${message}${missing}`;
    $('file-prev').hidden = $('file-next').hidden = marked.length < 2;
    $('file-focus').hidden = false;
    go(0);
  }

  $('file-prev').addEventListener('click', () => go(at - 1));
  $('file-next').addEventListener('click', () => go(at + 1));
  $('file-clear').addEventListener('click', clear);

  return {
    setRoster(r) {
      roster = r;
      render();
    },
    show,
  };
}
