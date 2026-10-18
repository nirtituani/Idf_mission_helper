// WhatsApp send panel ("לפי חייל" view): access code, contacts upload, template status, send to the
// selected soldiers (with an in-page confirm step) and a test send. Messages are always built on the
// server from the roster; phone numbers never reach the browser — only per-soldier statuses do.
import { el, ltr } from './ui.js';

const $ = (id) => document.getElementById(id);
const CHUNK = 5; // soldiers per POST /api/send (the server accepts up to 20)
const FINAL = new Set(['delivered', 'read', 'failed']);

const pad = (n) => String(n).padStart(2, '0');
// "18/10 12:05" in the browser's local time (Israel for the users).
export function stamp(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// Why sending is blocked by the template's Meta status, or null when it is approved.
export function templateBlock(template) {
  if (template === 'APPROVED') return null;
  if (template === 'PENDING') return 'התבנית עדיין ממתינה לאישור Meta';
  if (template === 'REJECTED') return 'התבנית נדחתה';
  if (template === 'MISSING') return 'התבנית לא נמצאה בחשבון Meta';
  if (template === 'ERROR') return 'לא ניתן לבדוק כרגע את סטטוס התבנית ב־Meta';
  return `התבנית אינה זמינה לשליחה (${template})`;
}

const SEND_LABEL = { accepted: 'נשלח ✓', sent: 'נשלח ✓', delivered: 'נמסר ✓✓', read: 'נקרא ✓✓', sending: 'בשליחה…' };
const chip = (text, kind, title, ...extra) => el('span', { class: `chip chip-${kind}`, ...(title ? { title } : {}) }, text, ...extra);
const POLL_MAX_AGE_MS = 30 * 60 * 1000; // stop auto-polling once the newest send is this old

// Status chips for one soldier's entry in GET /api/send/state (null → no chips).
export function sendChips(st) {
  if (!st) return [];
  const chips = [];
  if (st.contact === 'none') chips.push(chip('אין מספר', 'warn'));
  else if (st.contact === 'ambiguous') chips.push(chip('שם לא חד־משמעי', 'warn'));
  if (!st.sendable) chips.push(chip('לא ניתן לשלוח', 'err', st.problems?.[0]));
  const rec = st.send;
  if (rec) {
    if (rec.status === 'failed') chips.push(chip(`נכשל: ${rec.error || 'סיבה לא ידועה'}`, 'err'));
    else if (SEND_LABEL[rec.status]) {
      const kind = rec.status === 'read' ? 'read' : rec.status === 'sending' ? 'muted' : 'ok';
      const at = stamp(rec.sentAt);
      // accepted/sent: the send time is visible in the chip itself, not only in the tooltip
      if (at && (rec.status === 'accepted' || rec.status === 'sent')) chips.push(chip(`${SEND_LABEL[rec.status]} `, kind, at, ltr(at)));
      else chips.push(chip(SEND_LABEL[rec.status], kind, at));
    }
    if (rec.changed) chips.push(chip('השתנה מאז השליחה', 'warn'));
  }
  return chips;
}

function setStatus(node, kind, ...content) {
  node.className = kind ? `status status-${kind}` : 'status';
  node.replaceChildren(...content);
}

// getSelected() → selected soldier keys in roster order; onStateChange(state) after every refresh
// (state: the /api/send/state response for the current roster, or null).
export function createSendPanel({
  api, getRoster, getSelected, onStateChange, onStale = async () => {}, pollMs = 20000, now = Date.now,
  isVisible = () => !$('view-soldiers').hidden && !document.hidden,
}) {
  let state = null;
  let busy = false; // a send is running
  let timer = null;
  let seq = 0; // only the latest refresh may publish
  let loadError = false; // #send-status shows a state-load error (cleared by the next good load)

  const authorized = () => state?.enabled === true && state.authorized === true;
  const nameOf = (key) => getRoster()?.soldiers.find((s) => s.key === key)?.name ?? key;
  const entry = (key) => (authorized() ? state.soldiers.find((s) => s.key === key) : null);

  // On stale/no-roster the roster is reloaded first (which resets the panel), then the message is
  // shown — in `node` if it survived the reset, else in the panel's status line.
  async function handleError(e, node) {
    if (e.code === 'stale' || e.code === 'no-roster') {
      await onStale();
      setStatus(node?.isConnected ? node : $('send-status'), 'error', e.message);
      return;
    }
    if (node) setStatus(node, 'error', e.message);
    if (e.status === 401) await refresh(); // authorization lost (e.g. the session expired)
  }

  function publish(next) {
    state = next;
    render();
    onStateChange?.(state);
  }

  async function refresh() {
    clearTimeout(timer);
    timer = null;
    const my = ++seq;
    const roster = getRoster();
    if (!roster) return publish(null);
    try {
      const next = await api('GET', `/api/send/state?rosterVersion=${encodeURIComponent(roster.version)}`);
      if (my !== seq || getRoster()?.version !== roster.version) return; // a newer refresh/roster won
      if (loadError) setStatus($('send-status'), '');
      loadError = false;
      publish(next);
      schedule();
    } catch (e) {
      if (my !== seq) return;
      if (e.code === 'stale' || e.code === 'no-roster') return onStale();
      // Shown only in a panel that is already visible (sending may be off or unknown), and the
      // previous state keeps polling so a transient error doesn't stop the status updates.
      if (!$('send-panel').hidden) {
        loadError = true;
        setStatus($('send-status'), 'error', `לא ניתן לטעון את מצב השליחה: ${e.message}`);
      }
      schedule();
    }
  }

  // Poll while any message is still on its way (not delivered/read/failed), the newest send is less
  // than 30 minutes old (an old stuck one won't change; refresh() still works) and the tab is visible.
  function schedule() {
    if (!authorized() || !state.soldiers.some((s) => s.send && !FINAL.has(s.send.status))) return;
    const newest = Math.max(...state.soldiers.filter((s) => s.send).map((s) => Date.parse(s.send.sentAt) || 0));
    if (now() - newest > POLL_MAX_AGE_MS) return;
    const tick = () => {
      if (busy || !isVisible()) {
        timer = setTimeout(tick, pollMs);
        timer.unref?.();
        return;
      }
      refresh();
    };
    timer = setTimeout(tick, pollMs);
    timer.unref?.();
  }

  function render() {
    const panel = $('send-panel');
    const on = state?.enabled === true;
    panel.hidden = !on;
    $('send-auth').hidden = !on || state.authorized === true;
    $('send-tools').hidden = !authorized();
    $('send-selected').hidden = !authorized();
    if (!authorized()) {
      hideConfirm();
      return;
    }
    const block = templateBlock(state.template);
    $('send-template').replaceChildren(
      block ? el('span', { class: 'inline-warning' }, `⚠ ${block} — השליחה מושבתת עד לאישור.`) : el('span', { class: 'ok-text' }, 'תבנית ההודעה אושרה ב־Meta ✓'),
    );
    const c = state.contacts;
    $('contacts-info').replaceChildren(
      ...(c.count > 0
        ? [`${c.count} מספרים שמורים, עודכן `, ltr(c.updatedAt ? stamp(c.updatedAt) : '—')]
        : ['אין מספרים שמורים — יש להעלות קובץ אנשי קשר.']),
    );
    renderButton();
  }

  function renderButton() {
    const btn = $('send-selected');
    const block = authorized() ? templateBlock(state.template) : null;
    const n = getSelected().length;
    btn.textContent = n ? `שליחה לנבחרים (${n})` : 'שליחה לנבחרים';
    btn.disabled = busy || Boolean(block) || n === 0;
    if (block) btn.title = block;
    else btn.removeAttribute('title');
  }

  // ---- access code ----
  $('send-auth').addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = $('send-code');
    setStatus($('send-status'), 'loading', 'בודק את הקוד…');
    try {
      await api('POST', '/api/auth', { code: input.value });
      input.value = '';
      setStatus($('send-status'), '');
      await refresh();
    } catch (err) {
      if (err.code === 'no-roster') await onStale(); // reload first: it resets the status line
      setStatus($('send-status'), 'error', err.message); // a wrong code (401) stays on the form
    }
  });

  // ---- contacts upload ----
  $('contacts-file').addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const box = $('contacts-status');
    const line = el('p', {});
    box.replaceChildren(line);
    setStatus(line, 'loading', `מעלה את "${file.name}"…`);
    const fd = new FormData();
    fd.append('file', file);
    try {
      const res = await api('POST', '/api/contacts', fd);
      // Upload errors already say which row ("שורה 4: …"); a missing header has no row.
      const errors = res.errors.length ? [el('ul', { class: 'plain' }, ...res.errors.map((x) => el('li', {}, x.message)))] : [];
      if (res.count === 0) {
        setStatus(line, 'error', 'לא נמצאו בקובץ מספרים תקינים — רשימת אנשי הקשר לא השתנתה.');
      } else if (res.errors.length) {
        setStatus(line, 'warn', `נשמרו ${res.count} מספרים. ${res.errors.length} שורות לא נקלטו:`);
      } else {
        setStatus(line, 'ok', `נשמרו ${res.count} מספרים.`);
      }
      box.replaceChildren(line, ...errors);
      await refresh();
    } catch (err) {
      await handleError(err, line);
    } finally {
      try {
        e.target.value = '';
      } catch { /* some browsers/jsdom refuse resetting a file input */ }
    }
  });

  // ---- send to selected: confirm step ----
  function hideConfirm() {
    const box = $('send-confirm');
    box.hidden = true;
    box.replaceChildren();
  }

  function openConfirm() {
    if (!authorized() || busy) return;
    const keys = getSelected();
    const fresh = [];
    const already = [];
    const sending = [];
    const failed = [];
    for (const k of keys) {
      const rec = entry(k)?.send;
      if (!rec) fresh.push(k);
      else if (rec.status === 'failed') failed.push(k);
      else if (rec.status === 'sending') sending.push(k);
      else already.push(k);
    }
    const title = el('h4', { id: 'send-confirm-title' });
    const ok = el('button', { type: 'button', class: 'btn btn-primary', id: 'send-confirm-ok' }, 'שליחה');
    const cancel = el('button', { type: 'button', class: 'btn', id: 'send-confirm-cancel' }, 'ביטול');
    let resend = null;
    const targets = () => (resend?.checked ? keys : fresh);
    const update = () => {
      const n = targets().length;
      title.textContent = `לשלוח הודעה ל־${n} חיילים?`;
      ok.disabled = n === 0;
    };
    const parts = [title];
    if (state.weekStart) {
      const [y, m, d] = state.weekStart.split('-');
      parts.push(el('p', { class: 'muted small' }, 'הודעת השבוע שמתחיל ב־', ltr(`${d}/${m}/${y}`), ', כפי שמוצגת בתצוגה המקדימה של כל חייל.'));
    }
    if (already.length || sending.length || failed.length) {
      const facts = [];
      if (already.length) facts.push(`${already.length} כבר קיבלו את הודעת השבוע`);
      if (sending.length) facts.push(`${sending.length} בשליחה כרגע`);
      if (failed.length) facts.push(`${failed.length} נכשלו בשליחה קודמת`);
      parts.push(
        el('p', { class: 'status status-warn' }, `מתוך הנבחרים: ${facts.join(', ')}. הם לא יקבלו הודעה אלא אם תסמנו את התיבה.`),
        el('ul', { class: 'plain small' },
          ...[...already, ...sending].map((k) => el('li', {}, `${nameOf(k)} — ${SEND_LABEL[entry(k).send.status] ?? 'נשלח'}`)),
          ...failed.map((k) => el('li', {}, `${nameOf(k)} — נכשל: ${entry(k).send.error || 'סיבה לא ידועה'}`))),
      );
      resend = el('input', { type: 'checkbox', id: 'send-resend' });
      resend.addEventListener('change', update);
      const who = [];
      if (already.length) who.push('מי שכבר קיבל');
      if (sending.length) who.push('מי שבשליחה כרגע');
      if (failed.length) who.push('מי שהשליחה אליו נכשלה');
      const label = `לשלוח שוב גם ל${who.join(' ול')}`;
      parts.push(el('label', { class: 'check' }, resend, ` ${label}`));
    }
    parts.push(el('div', { class: 'row-actions' }, ok, cancel));
    // Re-checked against the state at click time: a poll may have made someone ineligible.
    ok.addEventListener('click', () => {
      const now = targets().filter((k) => {
        const st = entry(k);
        return st && st.sendable && st.contact === 'ok';
      });
      run(now, resend?.checked === true);
    });
    cancel.addEventListener('click', hideConfirm);
    const box = $('send-confirm');
    box.replaceChildren(...parts);
    update();
    box.hidden = false;
    box.scrollIntoView?.({ block: 'nearest' });
    box.focus?.();
  }

  // ---- send: chunks of 5, progress, summary ----
  async function run(keys, resend) {
    hideConfirm();
    const roster = getRoster();
    const host = $('send-progress');
    const line = el('p', {});
    host.replaceChildren(line);
    if (!keys.length) {
      setStatus(line, 'warn', 'לא נשלח דבר: אף אחד מהנבחרים אינו זמין עוד לשליחה (המצב עודכן).');
      return;
    }
    busy = true;
    renderButton();
    const results = [];
    let error = null;
    setStatus(line, 'loading', `נשלחו 0 מתוך ${keys.length}`);
    for (let i = 0; i < keys.length; i += CHUNK) {
      try {
        const res = await api('POST', '/api/send', { personKeys: keys.slice(i, i + CHUNK), rosterVersion: roster.version, resend });
        results.push(...res.results);
      } catch (e) {
        error = e;
        break;
      }
      setStatus(line, 'loading', `נשלחו ${results.length} מתוך ${keys.length}`);
    }
    busy = false;
    if (error?.code === 'stale' || error?.code === 'no-roster') {
      await onStale(); // reloads the roster and resets the panel — the summary goes in afterwards
      renderSummary(host, line, results, keys.length, error);
    } else {
      renderSummary(host, line, results, keys.length, error);
      await refresh();
    }
  }

  function renderSummary(host, line, results, total, error) {
    const accepted = results.filter((r) => r.status === 'accepted');
    const failed = results.filter((r) => r.status === 'failed');
    const skipped = results.filter((r) => r.status === 'skipped');
    const items = [
      ...accepted.filter((r) => r.reason).map((r) => el('li', { class: 'inline-warning' }, `${nameOf(r.key)}: נשלח ✓ — ⚠ ${r.reason}`)),
      ...failed.map((r) => el('li', { class: 'inline-error' }, `${nameOf(r.key)}: נכשל — ${r.reason}`)),
      ...skipped.map((r) => el('li', {}, `${nameOf(r.key)}: דולג — ${r.reason}`)),
    ];
    let text = `השליחה הסתיימה: ${accepted.length} נשלחו, ${failed.length} נכשלו, ${skipped.length} דולגו.`;
    if (error) text = `השליחה נעצרה: ${error.message} (${total - results.length} לא נשלחו). עד כה: ${accepted.length} נשלחו, ${failed.length} נכשלו, ${skipped.length} דולגו.`;
    const kind = error || failed.length ? 'error' : skipped.length || items.length ? 'warn' : 'ok';
    setStatus(line, kind, text);
    host.replaceChildren(line, ...(items.length ? [el('ul', { class: 'plain' }, ...items)] : []));
  }

  $('send-selected').addEventListener('click', openConfirm);

  // ---- per-soldier detail: last send + test send ----
  // Returns { node, update() }; update() re-reads the current state (called on every refresh).
  function detailControls(key) {
    const info = el('p', { class: 'muted small' });
    const btn = el('button', { type: 'button', class: 'btn test-send' }, 'שליחת בדיקה למספר שלי');
    const out = el('p', { class: 'status', role: 'status' });
    const note = el('p', { class: 'muted small' }, 'נשלחת למספר הבדיקה שהוגדר בשרת בלבד, ולא נרשמת כשליחה לחייל.');
    const node = el('div', { class: 'send-detail' }, el('h4', {}, 'שליחה ב־WhatsApp'), info, el('div', { class: 'row-actions' }, btn), out, note);
    const update = () => {
      const st = entry(key);
      node.hidden = !st;
      if (!st) return;
      const rec = st.send;
      info.replaceChildren(...(rec ? [`סטטוס: ${rec.status === 'failed' ? `נכשל: ${rec.error || 'סיבה לא ידועה'}` : SEND_LABEL[rec.status] ?? rec.status} · נשלח לאחרונה `, ltr(stamp(rec.sentAt))] : ['טרם נשלחה הודעה לחייל זה השבוע.']));
      const block = templateBlock(state.template) ?? (st.sendable ? null : st.problems[0]);
      btn.disabled = Boolean(block);
      if (block) btn.title = block;
      else btn.removeAttribute('title');
    };
    btn.addEventListener('click', async () => {
      const roster = getRoster();
      btn.disabled = true;
      setStatus(out, 'loading', 'שולח הודעת בדיקה…');
      try {
        const r = await api('POST', '/api/send/test', { personKey: key, rosterVersion: roster.version });
        if (r.status === 'accepted') setStatus(out, 'ok', 'הודעת הבדיקה נשלחה למספר הבדיקה ✓');
        else if (r.status === 'failed') setStatus(out, 'error', `הבדיקה נכשלה: ${r.reason}`);
        else setStatus(out, 'warn', `לא נשלח: ${r.reason}`);
      } catch (e) {
        await handleError(e, out);
      } finally {
        update();
      }
    });
    update();
    return { node, update };
  }

  return {
    refresh,
    // Selection changed in the soldier list.
    selectionChanged: renderButton,
    detailControls,
    // A new (or no) roster: drop the previous roster's confirm/progress, then reload the state.
    reset() {
      hideConfirm();
      $('send-progress').replaceChildren();
      setStatus($('send-status'), '');
      $('contacts-status').replaceChildren();
      return refresh();
    },
  };
}
