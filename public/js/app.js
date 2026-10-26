import { DatePicker, formatLong } from './datepicker.js';
import { createSoldiersView } from './soldiers-view.js';
import { createWeekView } from './week-view.js';
import { createShiftsView } from './shifts-view.js';
import { assignmentTable, cellChip, dayMonth, el, fillPostSelect, ltr, shiftNode, shortDate } from './ui.js';
import { addDays, dayNumber, formatMinutes, todayIso } from '/core/dates.js';

const $ = (id) => document.getElementById(id);
const state = { roster: null, date: todayIso(), hour: new Date().getHours(), issuesByAssignment: new Map() };
let datePicker = null;
let weekPicker = null;

// ---------- API ----------
async function api(method, url, body) {
  const opts = { method, headers: {} };
  if (body instanceof FormData) opts.body = body;
  else if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(url, opts);
  const data = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) throw Object.assign(new Error(data?.message || 'שגיאה בתקשורת עם השרת.'), { status: res.status, code: data?.error });
  return data;
}

// ---------- Upload ----------
function setStatus(kind, text) {
  const s = $('upload-status');
  s.className = `status status-${kind}`;
  s.textContent = text;
}

async function uploadFile(file) {
  if (!file) return;
  setStatus('loading', `מעבד את "${file.name}"…`);
  const fd = new FormData();
  fd.append('file', file);
  try {
    const roster = await api('POST', '/api/roster', fd);
    setRoster(roster);
    setStatus('ok', `הקובץ "${roster.fileName}" נטען ונותח.`);
  } catch (e) {
    const active = state.roster ? ` השיבוץ הפעיל עדיין: "${state.roster.fileName}".` : '';
    setStatus('error', `${e.message}${active}`);
  } finally {
    $('file').value = '';
  }
}

$('file').addEventListener('change', (e) => uploadFile(e.target.files[0]));
const drop = document.querySelector('.drop');
drop.addEventListener('dragover', (e) => {
  e.preventDefault();
  drop.classList.add('drop-active');
});
drop.addEventListener('dragleave', () => drop.classList.remove('drop-active'));
drop.addEventListener('drop', (e) => {
  e.preventDefault();
  drop.classList.remove('drop-active');
  uploadFile(e.dataTransfer.files[0]);
});

$('delete-btn').addEventListener('click', async () => {
  if (!confirm('למחוק את השיבוץ וכל הנתונים שנגזרו ממנו מהשרת?')) return;
  try {
    await api('DELETE', '/api/session');
    setRoster(null);
    setStatus('ok', 'השיבוץ נמחק מהשרת.');
  } catch (e) {
    setStatus('error', e.message);
  }
});

// ---------- Roster state ----------
function setRoster(roster) {
  state.roster = roster;
  state.issuesByAssignment = new Map();
  $('results').replaceChildren();
  if (!roster) {
    $('summary').hidden = true;
    $('issues').hidden = true;
    $('workload').hidden = true;
    $('active-file').hidden = true;
    $('search-form').hidden = true;
    $('search-empty').hidden = false;
    soldiersView.setRoster(null);
    weekView.setRoster(null);
    shiftsView.setRoster(null);
    return;
  }
  for (const issue of roster.issues) {
    for (const id of issue.assignmentIds) {
      if (!state.issuesByAssignment.has(id)) state.issuesByAssignment.set(id, []);
      state.issuesByAssignment.get(id).push(issue);
    }
  }
  renderSummary();
  renderIssues();
  renderSearchForm();
  soldiersView.setRoster(roster);
  weekView.setRoster(roster);
  shiftsView.setRoster(roster);
}

function rosterDates(roster) {
  const set = new Set();
  for (const a of roster.assignments) {
    if (a.kind === 'timed') {
      const last = a.endKey % 1440 === 0 ? dayNumber(a.end.date) - 1 : dayNumber(a.end.date);
      for (let d = a.start.date; dayNumber(d) <= last; d = addDays(d, 1)) set.add(d);
    }
  }
  return set;
}

// ---------- Summary ----------

function renderSummary() {
  const r = state.roster;
  const s = r.summary;
  // [label, big value, detail]
  const items = [
    ['חיילים', String(s.soldiers), 'שמות שונים לאחר איחוד'],
    ['שיבוצים', String(s.assignments), s.unresolved ? `${s.unresolved} ללא זמן מזוהה` : 'לכולם זמן מוגדר'],
    ['עמדות / תפקידים', String(s.positions), `ב־${s.sections} טבלאות`],
    ['טווח תאריכים', r.dateRange ? `${dayMonth(r.dateRange.from)}–${dayMonth(r.dateRange.to)}` : '—', r.dateRange ? `${formatLong(r.dateRange.from)} עד ${formatLong(r.dateRange.to)}` : 'לא זוהה'],
  ];
  $('summary-list').replaceChildren(
    ...items.map(([k, v, d]) => el('div', { class: 'stat' }, el('dt', {}, k), el('dd', {}, el('span', { class: 'stat-value' }, ltr(v)), el('span', { class: 'stat-detail' }, d)))),
  );
  $('active-file-name').textContent = r.fileName;
  $('active-file-range').replaceChildren(r.dateRange ? ltr(`${dayMonth(r.dateRange.from)} – ${dayMonth(r.dateRange.to)}`) : '');
  $('active-file').hidden = false;
  renderWeekStart();
  $('summary').hidden = false;
}

function renderWeekStart() {
  const r = state.roster;
  const box = $('week-start');
  // Several tabs = several weeks: one line per tab; the picker only fills tabs with no date.
  if (r.weekStarts?.length > 1) {
    const missing = r.weekStarts.filter((w) => !w.date || w.source === 'user');
    const lines = r.weekStarts.map((w) =>
      el('li', {}, el('strong', {}, w.sheet), ': ', w.date ? `שבוע מ${formatLong(w.date)}${w.source === 'workbook' ? ` (זוהה מ־${w.cell.split('!')[1]})` : ' (נקבע ידנית)'}` : 'לא נמצא תאריך — יש לבחור תחילת שבוע'),
    );
    const parts = [el('p', {}, `בקובץ ${r.weekStarts.length} לשוניות — כל לשונית היא שבוע נפרד:`), el('ul', { class: 'plain' }, ...lines)];
    weekPicker?.destroy();
    weekPicker = null;
    if (missing.length) {
      const pickerHost = el('div');
      parts.push(el('div', { class: 'week-controls' }, pickerHost));
      box.replaceChildren(...parts);
      weekPicker = new DatePicker(pickerHost, { value: missing[0].date || todayIso(), today: todayIso(), label: 'תאריך תחילת שבוע', onChange: (iso) => changeWeekStart(iso) });
    } else {
      box.replaceChildren(...parts);
    }
    return;
  }
  const ws = r.weekStart;
  const line = el('p');
  if (!ws) {
    line.className = 'week-missing';
    line.textContent = 'לא נמצא בקובץ תאריך מפורש. כדי לשייך ימים (ראשון, שני…) לתאריכים יש לבחור את תאריך יום ראשון של השבוע:';
  } else if (ws.source === 'workbook') {
    line.textContent = `תחילת השבוע: ${formatLong(ws.date)} — זוהה מהתא ${ws.cell} ("${ws.text}"). ימים ללא תאריך בקובץ מחושבים ממנו.`;
  } else {
    line.textContent = `תחילת השבוע: ${formatLong(ws.date)} — נקבע ידנית.`;
  }
  const controls = el('div', { class: 'week-controls' });
  const pickerHost = el('div');
  controls.append(pickerHost);
  if (ws?.source === 'user' && r.detectedWeekStart) {
    const reset = el('button', { type: 'button', class: 'btn' }, 'חזרה לתאריך שזוהה בקובץ');
    reset.addEventListener('click', () => changeWeekStart(null));
    controls.append(reset);
  }
  weekPicker?.destroy();
  box.replaceChildren(line, controls);
  weekPicker = new DatePicker(pickerHost, {
    value: ws?.date || todayIso(),
    today: todayIso(),
    label: 'תאריך תחילת שבוע',
    onChange: (iso) => changeWeekStart(iso),
  });
}

async function changeWeekStart(date) {
  try {
    setRoster(await api('PUT', '/api/roster/week-start', { date }));
  } catch (e) {
    setStatus('error', e.message);
  }
}

// ---------- Problems ----------
// Only real problems are shown (by request): data that could not be read (shifts may be missing)
// and soldiers booked twice at the same time. Merges, notes and empty slots stay hidden.
const PROBLEM_GROUPS = [
  { test: (i) => i.level === 'error', title: 'נתונים שלא נקראו — ייתכן שחסרים שיבוצים' },
  { test: (i) => i.code === 'OVERLAP' || i.code === 'DUPLICATE', title: 'חייל משובץ פעמיים באותו זמן' },
];

// Workload warnings: shown in their own card, styled apart from the problems above.
const WORKLOAD_GROUPS = [
  { test: (i) => i.code === 'LONG_DAY', title: 'יותר מ־12 שעות בתוך 24 שעות' },
  { test: (i) => i.code === 'SHORT_REST', title: 'פחות מ־8 שעות מנוחה בין משימות' },
];

function renderIssueGroups(card, body, defs) {
  const groups = defs.map((g) => ({ ...g, list: state.roster.issues.filter(g.test) })).filter((g) => g.list.length);
  $(card).hidden = groups.length === 0;
  $(body).replaceChildren(
    ...groups.flatMap((g) => [
      el('h3', { class: 'problem-title' }, `${g.title} (${g.list.length})`),
      el(
        'ul',
        { class: 'problem-list' },
        ...g.list.map((i) => {
          const li = el('li', {}, el('span', {}, i.message));
          if (i.cells.length) li.append(el('span', { class: 'cells' }, ...i.cells.slice(0, 8).map((c) => cellChip(c))));
          return li;
        }),
      ),
    ]),
  );
}

function renderIssues() {
  renderIssueGroups('issues', 'issues-body', PROBLEM_GROUPS);
  renderIssueGroups('workload', 'workload-body', WORKLOAD_GROUPS);
}

// ---------- Search form ----------
const hourSelect = $('hour');
for (let h = 0; h < 24; h++) hourSelect.append(el('option', { value: String(h) }, `${String(h).padStart(2, '0')}:00`));
hourSelect.addEventListener('change', () => {
  state.hour = Number(hourSelect.value);
  $('results').replaceChildren();
});
$('post').addEventListener('change', () => $('results').replaceChildren());

function renderSearchForm() {
  const r = state.roster;
  hourSelect.value = String(state.hour);

  // Options come only from this roster; previous options are discarded entirely.
  fillPostSelect($('post'), r.options);

  const dates = rosterDates(r);
  if (!datePicker) {
    datePicker = new DatePicker($('date-picker'), {
      value: state.date,
      today: todayIso(),
      markedDates: dates,
      label: 'תאריך',
      onChange: (iso) => {
        state.date = iso;
        $('results').replaceChildren();
      },
    });
  } else {
    datePicker.setMarked(dates);
  }
  $('search-form').hidden = false;
  $('search-empty').hidden = true;
}

$('search-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const results = $('results');
  const btn = $('search-btn');
  btn.disabled = true;
  results.replaceChildren(el('p', { class: 'status status-loading' }, 'מחפש…'));
  try {
    const res = await api('POST', '/api/search', {
      date: state.date,
      hour: state.hour,
      postId: $('post').value,
      rosterVersion: state.roster.version,
    });
    renderResults(res);
  } catch (err) {
    if (err.code === 'stale' || err.code === 'no-roster') {
      await loadExisting();
    }
    results.replaceChildren(el('p', { class: 'status status-error' }, err.message));
  } finally {
    btn.disabled = false;
  }
});

// ---------- Results ----------
function renderResults(res) {
  const q = res.query;
  const title = `${formatLong(q.date)} · ${formatMinutes(q.hour * 60)} · ${q.postLabel ?? 'כל העמדות והתפקידים'}`;
  const out = [el('h3', { class: 'results-title' }, title)];

  if (res.status === 'found') {
    out.push(el('p', { class: 'status status-ok' }, `נמצאו ${res.matches.length} שיבוצים פעילים בשעה זו.`));
    out.push(assignmentTable(res.matches, state.issuesByAssignment));
  } else if (res.status === 'outside-range') {
    const range = res.range ? ` (${shortDate(res.range.from)}–${shortDate(res.range.to)})` : '';
    out.push(el('p', { class: 'status status-warn' }, `התאריך שנבחר מחוץ לטווח השיבוץ שבקובץ${range}. אין בקובץ נתונים לתאריך זה.`));
  } else {
    out.push(el('p', { class: 'status status-warn' }, 'לא נמצא בקובץ שיבוץ מתאים לתאריך, לשעה ולעמדה שנבחרו.'));
  }

  if (res.emptySlots.length) {
    out.push(
      el('h4', {}, 'משבצות ריקות בקובץ בשעה זו'),
      el('ul', { class: 'plain' }, ...res.emptySlots.map((s) => el('li', {}, `${s.section ?? 'ללא כותרת'} › ${s.position ?? '—'} · `, shiftNode(s), ' · ', cellChip(s.cell)))),
    );
  }
  if (res.undetermined.length) {
    out.push(
      el('h4', {}, 'לא ניתן לקבוע'),
      el('p', { class: 'muted' }, 'שיבוצים בעמדה שנבחרה שלא ניתן היה לזהות את התאריך או השעות שלהם בקובץ. ייתכן שהם רלוונטיים — יש לבדוק בקובץ.'),
      assignmentTable(res.undetermined, state.issuesByAssignment),
    );
  }
  $('results').replaceChildren(...out);
}

async function loadExisting() {
  try {
    setRoster(await api('GET', '/api/roster'));
  } catch {
    setRoster(null);
  }
}

// ---------- Views (tabs) ----------
const tabs = [...document.querySelectorAll('#tabs [role="tab"]')];
const soldiersView = createSoldiersView({ api, onStale: loadExisting });
const shiftsView = createShiftsView();
const weekView = createWeekView({
  onShowSoldier: (personKey) => {
    showTab($('tab-soldiers'));
    soldiersView.focus(personKey);
  },
  onSearchDay: (date) => {
    state.date = date;
    datePicker?.setValue(date);
    $('results').replaceChildren();
    showTab($('tab-search'));
    $('view-search').scrollIntoView({ block: 'start' });
  },
});
function showTab(tab) {
  for (const t of tabs) {
    const on = t === tab;
    t.setAttribute('aria-selected', String(on));
    t.tabIndex = on ? 0 : -1;
    $(t.getAttribute('aria-controls')).hidden = !on;
  }
}
for (const t of tabs) {
  t.addEventListener('click', () => showTab(t));
  t.addEventListener('keydown', (e) => {
    const i = tabs.indexOf(t);
    const next = { ArrowLeft: tabs[(i + 1) % tabs.length], ArrowRight: tabs[(i - 1 + tabs.length) % tabs.length] }[e.key];
    if (next) {
      showTab(next);
      next.focus();
    }
  });
}

loadExisting();
