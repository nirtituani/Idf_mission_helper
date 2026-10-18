// DOM tests (jsdom) for the WhatsApp send panel inside the "לפי חייל" view, with a fake `api`.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import request from 'supertest';
import { parseRoster } from '../src/core/index.js';
import { rosterMessageBuilder } from '../src/core/wa-message.js';
import { createApp } from '../server/app.js';
import { createSessionStore } from '../server/sessions.js';
import { buildMainFixture } from './fixtures/build.js';

const html = fs.readFileSync(path.join(import.meta.dirname, '..', 'public', 'index.html'), 'utf8');
const dom = new JSDOM(html.replace(/<script[^>]*><\/script>/, ''), { url: 'http://localhost/', pretendToBeVisual: true });
Object.assign(globalThis, { window: dom.window, document: dom.window.document, FormData: dom.window.FormData });
const roster = await parseRoster(await buildMainFixture(), { fileName: 'a.xlsx', today: '2026-10-17' });
const build = rosterMessageBuilder(roster);
const keyOf = (name) => roster.soldiers.find((s) => s.name === name).key;

// ---- fake server behind the `api` function ----
const calls = [];
const server = { state: { enabled: false }, send: null, contacts: null, stateFail: 0 };
const apiError = (status, code, message) => Object.assign(new Error(message), { status, code });
const routes = {
  'GET /api/send/state': () => {
    if (server.stateFail > 0) {
      server.stateFail -= 1;
      throw apiError(500, 'server', 'שגיאת שרת.');
    }
    return structuredClone(server.state);
  },
  'POST /api/auth': (b) => {
    if (b.code !== '1234') throw apiError(401, 'auth', 'קוד הגישה שגוי.');
    server.state = stateFor();
    return null;
  },
  'POST /api/send': (b) => server.send?.(b) ?? { results: b.personKeys.map((key) => ({ key, status: 'accepted', reason: null })) },
  'POST /api/send/test': (b) => ({ key: b.personKey, status: 'accepted', reason: null }),
  'POST /api/contacts': () => server.contacts(),
  'POST /api/messages/preview': (b) => ({
    messages: b.personKeys.map((k) => {
      const s = roster.soldiers.find((x) => x.key === k);
      const { text, problems, warnings, sendable } = build(s);
      return { key: k, name: s.name, text, problems, warnings, sendable };
    }),
  }),
};
async function api(method, url, body) {
  const p = url.split('?')[0];
  calls.push({ method, url, path: p, body });
  const h = routes[`${method} ${p}`];
  if (!h) throw new Error(`unexpected ${method} ${url}`);
  await new Promise((r) => setTimeout(r, 1));
  return h(body);
}
const callsTo = (p) => calls.filter((c) => c.path === p);

function stateFor({ template = 'APPROVED', soldiers = {} } = {}) {
  return {
    enabled: true, authorized: true, template, weekStart: roster.weekStart.date,
    contacts: { count: 3, updatedAt: '2026-10-18T09:05:00.000Z' },
    soldiers: roster.soldiers.map((s) => {
      const m = build(s);
      return { key: s.key, contact: 'ok', sendable: m.sendable, problems: m.problems, warnings: m.warnings, send: null, ...soldiers[s.key] };
    }),
  };
}

const { createSoldiersView } = await import('../public/js/soldiers-view.js');
const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));
// Like the real app: onStale reloads the roster, which resets the view and the panel.
let staleCalls = 0;
const view = createSoldiersView({ api, onStale: async () => { staleCalls += 1; view.setRoster(roster); await tick(); }, pollMs: 40 });
const $ = (id) => document.getElementById(id);
$('view-soldiers').hidden = false;
const click = (n) => n.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
const row = (name) => [...document.querySelectorAll('#soldier-list .soldier')].find((li) => li.querySelector('.soldier-name').textContent === name);
const chips = (name) => [...row(name).querySelectorAll('.chip')].map((c) => c.textContent);
function pick(name, on = true) {
  const box = row(name).querySelector('input[type="checkbox"]');
  box.checked = on;
  box.dispatchEvent(new dom.window.Event('change'));
}
async function load(state) {
  server.state = state;
  server.send = null;
  server.stateFail = 0;
  view.setRoster(roster);
  await tick();
}

test('sending disabled on the server → no send panel; preview still works', async () => {
  await load({ enabled: false });
  assert.equal($('send-panel').hidden, true);
  assert.equal($('send-selected').hidden, true);
  assert.equal(document.querySelector('.notice'), null); // the old "not connected" notice is gone
  pick('אבי דמה');
  assert.equal($('preview-selected').disabled, false);
});

test('not authorized → only the access-code form; a wrong code shows the error', async () => {
  await load({ enabled: true, authorized: false });
  assert.equal($('send-panel').hidden, false);
  assert.equal($('send-auth').hidden, false);
  assert.equal($('send-tools').hidden, true);
  assert.equal($('send-selected').hidden, true);
  assert.equal(chips('אבי דמה').length, 0);
  $('send-code').value = '0000';
  $('send-auth').dispatchEvent(new dom.window.Event('submit', { cancelable: true }));
  await tick();
  assert.match($('send-status').textContent, /קוד הגישה שגוי/);
  assert.equal($('send-tools').hidden, true);
});

test('the right code → state refreshed, tools shown with contacts count and template line', async () => {
  $('send-code').value = '1234';
  $('send-auth').dispatchEvent(new dom.window.Event('submit', { cancelable: true }));
  await tick(60);
  assert.equal($('send-auth').hidden, true);
  assert.equal($('send-tools').hidden, false);
  assert.equal($('send-selected').hidden, false);
  assert.equal($('send-code').value, '');
  assert.match($('contacts-info').textContent, /^3 מספרים שמורים, עודכן /);
  assert.ok($('contacts-info').querySelector('bdi[dir="ltr"]'));
  assert.match($('send-template').textContent, /אושרה/);
});

test('status chips per soldier from the send state', async () => {
  await load(stateFor({
    soldiers: {
      [keyOf('אבי דמה')]: { contact: 'none' },
      [keyOf('אור דמה')]: { contact: 'ambiguous' },
      [keyOf('אורי דמה')]: { send: { status: 'accepted', error: null, sentAt: '2026-10-18T09:00:00.000Z', changed: false } },
      [keyOf('אלון דמה')]: { send: { status: 'sent', error: null, sentAt: '2026-10-18T09:00:00.000Z', changed: false } },
      [keyOf('בני דמה')]: { send: { status: 'delivered', error: null, sentAt: '2026-10-18T09:00:00.000Z', changed: false } },
      [keyOf('דני דמה')]: { send: { status: 'read', error: null, sentAt: '2026-10-18T09:00:00.000Z', changed: true } },
      [keyOf('הדר דמה')]: { send: { status: 'failed', error: 'המספר אינו זמין ב־WhatsApp', sentAt: '2026-10-18T09:00:00.000Z', changed: false } },
      [keyOf('ורד דמה')]: { send: { status: 'sending', error: null, sentAt: '2026-10-18T09:00:00.000Z', changed: false } },
    },
  }));
  assert.deepEqual(chips('אבי דמה'), ['אין מספר']);
  assert.deepEqual(chips('אור דמה'), ['שם לא חד־משמעי']);
  assert.deepEqual(chips('אורי דמה'), ['נשלח ✓']);
  assert.deepEqual(chips('אלון דמה'), ['נשלח ✓']);
  assert.deepEqual(chips('בני דמה'), ['נמסר ✓✓']);
  assert.deepEqual(chips('דני דמה'), ['נקרא ✓✓', 'השתנה מאז השליחה']);
  assert.ok(row('דני דמה').querySelector('.chip-read'));
  assert.deepEqual(chips('הדר דמה'), ['נכשל: המספר אינו זמין ב־WhatsApp']);
  assert.equal(chips('ורד דמה').length, 1);
  assert.deepEqual(chips('זיו דמה'), []);
  assert.ok(chips('עומר דמה').some((t) => /לא ניתן לשלוח/.test(t)));
  // eligible = sendable && contact ok
  assert.equal(row('אבי דמה').querySelector('input').disabled, true);
  assert.equal(row('אור דמה').querySelector('input').disabled, true);
  assert.equal(row('עומר דמה').querySelector('input').disabled, true);
  assert.equal(row('הדר דמה').querySelector('input').disabled, false); // failed → can be re-sent
  assert.equal(row('זיו דמה').querySelector('input').disabled, false);
});

test('template pending/rejected → send buttons disabled with the reason', async () => {
  await load(stateFor({ template: 'PENDING' }));
  pick('זיו דמה');
  assert.equal($('send-selected').disabled, true);
  assert.match($('send-template').textContent, /התבנית עדיין ממתינה לאישור Meta/);
  click(row('זיו דמה').querySelector('.soldier-name'));
  await tick();
  const testBtn = row('זיו דמה').querySelector('.test-send');
  assert.equal(testBtn.textContent, 'שליחת בדיקה למספר שלי');
  assert.equal(testBtn.disabled, true);
  await load(stateFor({ template: 'REJECTED' }));
  pick('זיו דמה');
  assert.equal($('send-selected').disabled, true);
  assert.match($('send-template').textContent, /התבנית נדחתה/);
  await load(stateFor());
  pick('זיו דמה');
  assert.equal($('send-selected').disabled, false);
});

test('test send from the soldier detail posts only that soldier', async () => {
  await load(stateFor());
  click(row('טל דמה').querySelector('.soldier-name'));
  await tick();
  const before = callsTo('/api/send/test').length;
  click(row('טל דמה').querySelector('.test-send'));
  await tick();
  const c = callsTo('/api/send/test');
  assert.equal(c.length, before + 1);
  assert.deepEqual(c.at(-1).body, { personKey: keyOf('טל דמה'), rosterVersion: roster.version });
  assert.match(row('טל דמה').querySelector('.soldier-detail').textContent, /הודעת הבדיקה נשלחה/);
  assert.equal(callsTo('/api/send').length, 0);
});

test('cancel in the confirm step sends nothing', async () => {
  await load(stateFor());
  pick('זיו דמה');
  click($('send-selected'));
  assert.equal($('send-confirm').hidden, false);
  assert.match($('send-confirm').textContent, /לשלוח הודעה ל־1 חיילים\?/);
  click($('send-confirm-cancel'));
  await tick();
  assert.equal($('send-confirm').hidden, true);
  assert.equal(callsTo('/api/send').length, 0);
});

test('confirm → 7 selected soldiers are sent in two chunks, with progress and a summary', async () => {
  await load(stateFor());
  const names = ['זיו דמה', 'חן דמה', 'טל דמה', 'יעל דמה', 'כרם דמה', 'לוטם דמה', 'מור דמה'];
  for (const n of names) pick(n);
  click($('send-selected'));
  assert.match($('send-confirm').textContent, /לשלוח הודעה ל־7 חיילים\?/);
  assert.equal($('send-resend'), null); // nobody here was sent before
  const stateCalls = callsTo('/api/send/state').length;
  click($('send-confirm-ok'));
  await tick(80);
  const sends = callsTo('/api/send');
  assert.equal(sends.length, 2);
  assert.deepEqual(sends.map((c) => c.body.personKeys.length), [5, 2]);
  assert.deepEqual(sends.flatMap((c) => c.body.personKeys).sort(), names.map(keyOf).sort());
  assert.ok(sends.every((c) => c.body.resend === false && c.body.rosterVersion === roster.version));
  assert.match($('send-progress').textContent, /7 נשלחו/);
  assert.ok(callsTo('/api/send/state').length > stateCalls); // state refreshed afterwards
});

test('already-sent and failed soldiers are sent only when the resend box is checked', async () => {
  calls.length = 0;
  const sentRec = { status: 'delivered', error: null, sentAt: '2026-10-18T09:00:00.000Z', changed: false };
  const failRec = { status: 'failed', error: 'שגיאת Meta (קוד 1)', sentAt: '2026-10-18T09:00:00.000Z', changed: false };
  const state = stateFor({ soldiers: { [keyOf('נוי דמה')]: { send: sentRec }, [keyOf('עדי דמה')]: { send: failRec } } });
  await load(state);
  for (const n of ['נוי דמה', 'עדי דמה', 'פז דמה']) pick(n);
  click($('send-selected'));
  const box = $('send-confirm');
  assert.match(box.textContent, /לשלוח הודעה ל־1 חיילים\?/);
  assert.match(box.textContent, /1 כבר קיבלו/);
  assert.match(box.textContent, /1 נכשלו/);
  assert.match(box.textContent, /לשלוח שוב גם למי שכבר קיבל/);
  assert.equal($('send-resend').checked, false);
  click($('send-confirm-ok'));
  await tick(60);
  assert.deepEqual(callsTo('/api/send').map((c) => [c.body.personKeys, c.body.resend]), [[[keyOf('פז דמה')], false]]);

  await load(state);
  for (const n of ['נוי דמה', 'עדי דמה', 'פז דמה']) pick(n);
  click($('send-selected'));
  const resend = $('send-resend');
  resend.checked = true;
  resend.dispatchEvent(new dom.window.Event('change'));
  assert.match($('send-confirm').textContent, /לשלוח הודעה ל־3 חיילים\?/);
  click($('send-confirm-ok'));
  await tick(60);
  const last = callsTo('/api/send').at(-1).body;
  assert.equal(last.resend, true);
  assert.deepEqual([...last.personKeys].sort(), ['נוי דמה', 'עדי דמה', 'פז דמה'].map(keyOf).sort());
});

test('send results: failed and skipped listed with reasons; "saved record failed" shown as sent with a warning', async () => {
  await load(stateFor());
  server.send = (b) => ({
    results: [
      { key: b.personKeys[0], status: 'accepted', reason: 'ההודעה נשלחה, אך שמירת הרישום נכשלה — אין לשלוח שוב' },
      { key: b.personKeys[1], status: 'failed', reason: 'שגיאת Meta (קוד 1)' },
      { key: b.personKeys[2], status: 'skipped', reason: 'נשלח כבר' },
    ],
  });
  for (const n of ['קרן דמה', 'רון דמה', 'שי דמה']) pick(n);
  click($('send-selected'));
  click($('send-confirm-ok'));
  await tick(60);
  const text = $('send-progress').textContent;
  assert.match(text, /1 נשלחו/);
  assert.match(text, /1 נכשלו/);
  assert.match(text, /1 דולגו/);
  assert.match(text, /קרן דמה: נשלח ✓ — ⚠ ההודעה נשלחה, אך שמירת הרישום נכשלה — אין לשלוח שוב/);
  assert.match(text, /רון דמה: נכשל — שגיאת Meta \(קוד 1\)/);
  assert.match(text, /שי דמה: דולג — נשלח כבר/);
});

test('contacts upload: count and row errors; a missing header shows no "שורה 0"', async () => {
  await load(stateFor());
  const input = $('contacts-file');
  const upload = async () => {
    Object.defineProperty(input, 'files', { configurable: true, value: [new dom.window.File(['x'], 'אנשי קשר.xlsx')] });
    input.dispatchEvent(new dom.window.Event('change'));
    await tick(60);
  };
  server.contacts = () => ({ count: 2, errors: [{ row: 4, message: 'שורה 4: מספר טלפון לא תקין' }] });
  await upload();
  assert.match($('contacts-status').textContent, /נשמרו 2 מספרים/);
  assert.match($('contacts-status').textContent, /שורה 4: מספר טלפון לא תקין/);
  server.contacts = () => ({ count: 0, errors: [{ row: 0, message: 'לא נמצאה כותרת עם העמודות שם וטלפון' }] });
  await upload();
  assert.match($('contacts-status').textContent, /לא נמצאה כותרת עם העמודות שם וטלפון/);
  assert.match($('contacts-status').textContent, /לא השתנתה/);
  assert.ok(!/שורה 0/.test($('contacts-status').textContent));
});

test('state auto-refreshes while a send is not yet delivered/read/failed and the tab is visible', async () => {
  await load(stateFor({ soldiers: { [keyOf('תום דמה')]: { send: { status: 'accepted', error: null, sentAt: '2026-10-18T09:00:00.000Z', changed: false } } } }));
  let n = callsTo('/api/send/state').length;
  await tick(300);
  assert.ok(callsTo('/api/send/state').length >= n + 2, 'polls while pending');

  $('view-soldiers').hidden = true;
  await tick(60);
  n = callsTo('/api/send/state').length;
  await tick(150);
  assert.equal(callsTo('/api/send/state').length, n, 'no polling while the tab is hidden');
  $('view-soldiers').hidden = false;

  await load(stateFor({ soldiers: { [keyOf('תום דמה')]: { send: { status: 'read', error: null, sentAt: '2026-10-18T09:00:00.000Z', changed: false } } } }));
  n = callsTo('/api/send/state').length;
  await tick(150);
  assert.equal(callsTo('/api/send/state').length, n, 'no polling once everything is final');
});

test('roster replaced mid-send (409 on the 2nd chunk): the stop message survives the reload', async () => {
  await load(stateFor());
  let n = 0;
  server.send = (b) => {
    n += 1;
    if (n === 2) throw apiError(409, 'stale', 'השיבוץ הוחלף מאז שהמסך נטען. יש לרענן את הנתונים.');
    return { results: b.personKeys.map((key) => ({ key, status: 'accepted', reason: null })) };
  };
  const before = staleCalls;
  for (const name of ['זיו דמה', 'חן דמה', 'טל דמה', 'יעל דמה', 'כרם דמה', 'לוטם דמה', 'מור דמה']) pick(name);
  click($('send-selected'));
  click($('send-confirm-ok'));
  await tick(200);
  assert.equal(staleCalls, before + 1);
  const text = $('send-progress').textContent;
  assert.match(text, /השליחה נעצרה: השיבוץ הוחלף/);
  assert.match(text, /\(2 לא נשלחו\)/);
  assert.match(text, /5 נשלחו/);
});

test('roster replaced before a contacts upload: the error stays visible after the reload', async () => {
  await load(stateFor());
  server.contacts = () => { throw apiError(409, 'stale', 'השיבוץ הוחלף מאז שהמסך נטען. יש לרענן את הנתונים.'); };
  const input = $('contacts-file');
  Object.defineProperty(input, 'files', { configurable: true, value: [new dom.window.File(['x'], 'c.xlsx')] });
  input.dispatchEvent(new dom.window.Event('change'));
  await tick(120);
  assert.match($('send-panel').textContent, /השיבוץ הוחלף/);
});

test('a soldier who became ineligible while the confirm step was open is not sent', async () => {
  const pending = { [keyOf('תום דמה')]: { send: { status: 'accepted', error: null, sentAt: '2026-10-18T09:00:00.000Z', changed: false } } };
  await load(stateFor({ soldiers: pending }));
  calls.length = 0;
  pick('זיו דמה');
  pick('חן דמה');
  click($('send-selected'));
  assert.match($('send-confirm').textContent, /לשלוח הודעה ל־2 חיילים\?/);
  server.state = stateFor({ soldiers: { ...pending, [keyOf('זיו דמה')]: { contact: 'none' } } });
  await tick(200); // a poll picks up the new state while the dialog is open
  assert.ok(callsTo('/api/send/state').length >= 1);
  click($('send-confirm-ok'));
  await tick(60);
  assert.deepEqual(callsTo('/api/send').map((c) => c.body.personKeys), [[keyOf('חן דמה')]]);
});

test('a failed poll keeps polling; a load error never reveals a hidden panel', async () => {
  await load(stateFor({ soldiers: { [keyOf('תום דמה')]: { send: { status: 'accepted', error: null, sentAt: '2026-10-18T09:00:00.000Z', changed: false } } } }));
  server.stateFail = 1000; // the server keeps failing
  const n = callsTo('/api/send/state').length;
  await tick(300);
  assert.ok(callsTo('/api/send/state').length >= n + 2, 'polling continues through errors');
  assert.match($('send-status').textContent, /לא ניתן לטעון את מצב השליחה/);
  server.stateFail = 0;
  await tick(200);
  assert.equal($('send-status').textContent, ''); // cleared by the next successful load

  server.state = { enabled: false };
  view.setRoster(roster);
  await tick();
  assert.equal($('send-panel').hidden, true);
  server.stateFail = 1;
  view.setRoster(roster);
  await tick();
  assert.equal($('send-panel').hidden, true);
});

test('privacy page is served (with and without .html), standalone, with the operator contact; linked in the footer', async () => {
  const app = createApp({ store: createSessionStore({ idleTtlMs: 1e6, maxAgeMs: 1e6 }), log: { warn() {}, error() {} } });
  for (const url of ['/privacy', '/privacy.html']) {
    const res = await request(app).get(url);
    assert.equal(res.status, 200, url);
    assert.match(res.headers['content-type'], /text\/html/);
    assert.match(res.text, /^<!doctype html>/i);
    assert.match(res.text, /nirtituani13@gmail\.com/);
    assert.match(res.text, /Nir Tituani/);
    assert.ok(!/[Nn]ames and phone numbers[^.]*stored encrypted/.test(res.text), 'only phone numbers are encrypted');
    assert.match(res.text, /<meta name="viewport"/);
    assert.match(res.text, /href="\/styles\.css"/);
    assert.ok(!/<script(?![^>]*\bsrc=)/i.test(res.text), 'no inline scripts (CSP)');
  }
  assert.ok(document.querySelector('footer a[href="/privacy"]'));
});
