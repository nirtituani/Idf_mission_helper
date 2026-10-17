// "לפי חייל" view: search, select, inspect a soldier's assignments, preview personal messages.
// Message text always comes from the server (same generator that will send it later).
import { assignmentTable, copyText, el } from './ui.js';

const $ = (id) => document.getElementById(id);

export function createSoldiersView({ api, onStale }) {
  let roster = null;
  let issuesByAssignment = new Map();
  let issuesById = new Map();
  const selected = new Set();
  const expanded = new Set();

  const eligible = (s) => !s.ambiguous && s.timedCount > 0;
  const visible = () => {
    const q = $('soldier-filter').value.trim();
    return roster.soldiers.filter((s) => !q || s.name.includes(q) || s.spellings.some((n) => n.includes(q)));
  };

  async function preview(keys) {
    try {
      return (await api('POST', '/api/messages/preview', { personKeys: keys, rosterVersion: roster.version })).messages;
    } catch (e) {
      if (e.code === 'stale' || e.code === 'no-roster') await onStale();
      throw e;
    }
  }

  function messageBlock(msg) {
    const box = el('div', { class: 'message' });
    for (const p of msg.problems) box.append(el('p', { class: 'inline-issue inline-warning' }, `⚠ ${p}`));
    box.append(el('pre', { class: 'message-text', dir: 'rtl' }, msg.text));
    const copy = el('button', { type: 'button', class: 'btn' }, 'העתקת ההודעה');
    copy.addEventListener('click', async () => {
      copy.textContent = (await copyText(msg.text)) ? 'הועתק ✓' : 'ההעתקה נכשלה';
    });
    box.append(copy);
    return box;
  }

  async function renderDetail(s, host) {
    const byId = new Map(roster.assignments.map((a) => [a.id, a]));
    const list = s.assignmentIds.map((id) => byId.get(id));
    const parts = [];
    if (s.spellings.length > 1) parts.push(el('p', { class: 'muted' }, `מופיע בקובץ בכתיבים: ${s.spellings.map((n) => `"${n}"`).join(', ')} (אוחדו כחייל אחד).`));
    parts.push(assignmentTable(list, issuesByAssignment, { soldierColumn: false, dateColumn: true }));
    const issues = s.issueIds.map((id) => issuesById.get(id));
    if (issues.length) {
      parts.push(el('h4', {}, 'בדיקות לחייל זה'), el('ul', { class: 'plain' }, ...issues.map((i) => el('li', { class: `inline-${i.level}` }, i.message))));
    }
    parts.push(el('h4', {}, 'הודעה אישית'));
    const msgHost = el('div', {}, el('p', { class: 'status status-loading' }, 'מכין הודעה…'));
    parts.push(msgHost);
    host.replaceChildren(...parts);
    try {
      const [msg] = await preview([s.key]);
      msgHost.replaceChildren(messageBlock(msg));
    } catch (e) {
      msgHost.replaceChildren(el('p', { class: 'status status-error' }, e.message));
    }
  }

  function renderList() {
    const list = $('soldier-list');
    const shown = visible();
    list.replaceChildren(
      ...shown.map((s) => {
        const checkbox = el('input', { type: 'checkbox', 'aria-label': `בחירת ${s.name}` });
        checkbox.checked = selected.has(s.key);
        checkbox.disabled = !eligible(s);
        checkbox.addEventListener('change', () => {
          if (checkbox.checked) selected.add(s.key);
          else selected.delete(s.key);
          renderToolbar();
        });
        const detail = el('div', { class: 'soldier-detail' });
        detail.hidden = !expanded.has(s.key);
        const nameBtn = el('button', { type: 'button', class: 'soldier-name', 'aria-expanded': String(expanded.has(s.key)) }, s.name);
        nameBtn.addEventListener('click', () => {
          const open = !expanded.has(s.key);
          if (open) expanded.add(s.key);
          else expanded.delete(s.key);
          nameBtn.setAttribute('aria-expanded', String(open));
          detail.hidden = !open;
          if (open) renderDetail(s, detail);
        });
        if (expanded.has(s.key)) renderDetail(s, detail);
        const meta = [el('span', { class: 'muted' }, `${s.timedCount} שיבוצים`)];
        const warnCount = s.issueIds.filter((id) => issuesById.get(id)?.level !== 'info').length;
        if (warnCount) meta.push(el('span', { class: 'badge badge-warn' }, `⚠ ${warnCount}`));
        if (s.ambiguous) meta.push(el('span', { class: 'badge badge-warn' }, 'יותר משם אחד בתא'));
        if (s.unresolvedCount) meta.push(el('span', { class: 'badge badge-warn' }, `${s.unresolvedCount} ללא זמן`));
        return el('li', { class: 'soldier' }, el('div', { class: 'soldier-row' }, checkbox, nameBtn, ...meta), detail);
      }),
    );
    if (!shown.length) list.append(el('li', { class: 'muted' }, 'לא נמצאו חיילים התואמים לחיפוש.'));
    renderToolbar();
  }

  function renderToolbar() {
    const shownEligible = visible().filter(eligible);
    const all = $('select-all');
    all.checked = shownEligible.length > 0 && shownEligible.every((s) => selected.has(s.key));
    all.indeterminate = !all.checked && shownEligible.some((s) => selected.has(s.key));
    $('selected-count').textContent = `נבחרו ${selected.size} מתוך ${roster.soldiers.filter(eligible).length} חיילים שניתן להכין להם הודעה`;
    $('preview-selected').disabled = selected.size === 0;
  }

  $('soldier-filter').addEventListener('input', () => roster && renderList());
  $('select-all').addEventListener('change', (e) => {
    for (const s of visible().filter(eligible)) {
      if (e.target.checked) selected.add(s.key);
      else selected.delete(s.key);
    }
    renderList();
  });

  $('preview-selected').addEventListener('click', async () => {
    const host = $('bulk-preview');
    const keys = roster.soldiers.filter((s) => selected.has(s.key)).map((s) => s.key);
    host.replaceChildren(el('p', { class: 'status status-loading' }, `מכין ${keys.length} הודעות…`));
    try {
      const messages = await preview(keys);
      const copyAll = el('button', { type: 'button', class: 'btn' }, 'העתקת כל ההודעות');
      copyAll.addEventListener('click', async () => {
        const all = messages.map((m) => `===== ${m.name} =====\n${m.text}`).join('\n\n');
        copyAll.textContent = (await copyText(all)) ? 'הועתק ✓' : 'ההעתקה נכשלה';
      });
      const withProblems = messages.filter((m) => m.problems.length).length;
      host.replaceChildren(
        el('h3', {}, `תצוגה מקדימה: ${messages.length} הודעות`),
        el('p', { class: withProblems ? 'status status-warn' : 'status status-ok' }, withProblems ? `${withProblems} הודעות דורשות בדיקה (מסומנות ב־⚠).` : 'כל ההודעות נוצרו מהשיבוצים שבקובץ.'),
        copyAll,
        ...messages.map((m) => el('section', { class: 'bulk-item' }, el('h4', {}, m.name), messageBlock(m))),
      );
    } catch (e) {
      host.replaceChildren(el('p', { class: 'status status-error' }, e.message));
    }
  });

  // ---- Template ----
  const fields = ['greeting', 'intro', 'closing'];
  async function loadTemplate() {
    try {
      const { template } = await api('GET', '/api/messages/template');
      for (const f of fields) $(`tpl-${f}`).value = template[f];
    } catch {
      /* no roster yet */
    }
  }
  async function saveTemplate(template) {
    const status = $('tpl-status');
    try {
      const res = await api('PUT', '/api/messages/template', { template });
      for (const f of fields) $(`tpl-${f}`).value = res.template[f];
      status.className = 'status status-ok';
      status.textContent = 'הנוסח נשמר. ההודעות יוצגו בנוסח החדש.';
      $('bulk-preview').replaceChildren();
      renderList();
    } catch (e) {
      status.className = 'status status-error';
      status.textContent = e.message;
    }
  }
  $('template-form').addEventListener('submit', (e) => {
    e.preventDefault();
    saveTemplate(Object.fromEntries(fields.map((f) => [f, $(`tpl-${f}`).value])));
  });
  $('tpl-reset').addEventListener('click', () => saveTemplate(null));

  return {
    // Show one soldier: filter to them and expand their details.
    focus(key) {
      const s = roster?.soldiers.find((x) => x.key === key);
      if (!s) return;
      $('soldier-filter').value = s.name;
      expanded.add(key);
      renderList();
      $('soldier-list').querySelector('.soldier-name')?.scrollIntoView({ block: 'center' });
    },
    setRoster(next) {
      roster = next;
      selected.clear();
      expanded.clear();
      $('bulk-preview').replaceChildren();
      $('soldier-filter').value = '';
      if (!roster) {
        $('soldiers-body').hidden = true;
        $('soldiers-empty').hidden = false;
        return;
      }
      issuesByAssignment = new Map();
      issuesById = new Map(roster.issues.map((i) => [i.id, i]));
      for (const issue of roster.issues) {
        for (const id of issue.assignmentIds) {
          if (!issuesByAssignment.has(id)) issuesByAssignment.set(id, []);
          issuesByAssignment.get(id).push(issue);
        }
      }
      $('soldiers-body').hidden = false;
      $('soldiers-empty').hidden = true;
      renderList();
      loadTemplate();
    },
  };
}
