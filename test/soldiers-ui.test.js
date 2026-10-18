// DOM tests (jsdom) for the "לפי חייל" view, wired to the real core logic through a fake fetch.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import { parseRoster } from '../src/core/index.js';
import { rosterMessageBuilder } from '../src/core/wa-message.js';
import { buildMainFixture } from './fixtures/build.js';

const html = fs.readFileSync(path.join(import.meta.dirname, '..', 'public', 'index.html'), 'utf8');
const dom = new JSDOM(html.replace(/<script[^>]*><\/script>/, ''), { url: 'http://localhost/' });
Object.assign(globalThis, { window: dom.window, document: dom.window.document, FormData: dom.window.FormData });
const roster = await parseRoster(await buildMainFixture(), { fileName: 'a.xlsx', today: '2026-10-17' });
const byId = new Map(roster.assignments.map((a) => [a.id, a]));
const buildMsg = rosterMessageBuilder(roster);
const previewCalls = [];
globalThis.fetch = async (url, opts = {}) => {
  const json = (status, body) => ({ ok: status < 400, status, json: async () => body });
  if (url === '/api/roster') return json(200, roster);
  if (url === '/api/messages/preview') {
    const { personKeys } = JSON.parse(opts.body);
    previewCalls.push(personKeys);
    const messages = personKeys.map((k) => {
      const s = roster.soldiers.find((x) => x.key === k);
      const { text, problems, warnings, sendable } = buildMsg(s);
      return { key: k, name: s.name, text, problems, warnings, sendable };
    });
    return json(200, { messages });
  }
  throw new Error(`unexpected ${url}`);
};
await import('../public/js/app.js');
const tick = () => new Promise((r) => setTimeout(r, 20));
await tick();
const $ = (id) => document.getElementById(id);
const click = (n) => n.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
const rows = () => [...document.querySelectorAll('#soldier-list .soldier')];
const nameOf = (li) => li.querySelector('.soldier-name').textContent;

test('tabs switch between search and soldier views', () => {
  assert.equal($('view-soldiers').hidden, true);
  click($('tab-soldiers'));
  assert.equal($('view-soldiers').hidden, false);
  assert.equal($('view-search').hidden, true);
  assert.equal($('tab-soldiers').getAttribute('aria-selected'), 'true');
});

test('one row per soldier from the roster, nothing else', () => {
  assert.deepEqual(rows().map(nameOf), roster.soldiers.map((s) => s.name));
});

test('name filter matches any spelling', () => {
  const f = $('soldier-filter');
  f.value = 'נוה';
  f.dispatchEvent(new dom.window.Event('input'));
  assert.deepEqual(rows().map(nameOf), ['נווה דמה']);
  f.value = '';
  f.dispatchEvent(new dom.window.Event('input'));
});

test('select all picks only soldiers a message can be prepared for', () => {
  const all = $('select-all');
  all.checked = true;
  all.dispatchEvent(new dom.window.Event('change'));
  const eligible = roster.soldiers.filter((s) => !s.ambiguous && s.timedCount > 0);
  const checked = rows().filter((li) => li.querySelector('input').checked).map(nameOf);
  assert.deepEqual(checked, eligible.map((s) => s.name));
  assert.equal($('preview-selected').disabled, false);
});

test('bulk preview requests the selected soldiers and shows each message', async () => {
  click($('preview-selected'));
  await tick();
  const eligible = roster.soldiers.filter((s) => !s.ambiguous && s.timedCount > 0);
  assert.equal(previewCalls.at(-1).length, eligible.length);
  assert.equal(document.querySelectorAll('#bulk-preview .message-text').length, eligible.length);
});

test('expanding a soldier shows their assignments with source cells and the message', async () => {
  const li = rows().find((r) => nameOf(r) === 'גדי דמה');
  click(li.querySelector('.soldier-name'));
  await tick();
  const detail = li.querySelector('.soldier-detail');
  assert.equal(detail.hidden, false);
  assert.equal(detail.querySelectorAll('tbody tr').length, 2);
  const cells = roster.soldiers.find((s) => s.name === 'גדי דמה').assignmentIds.map((id) => byId.get(id).source.cell);
  for (const c of cells) assert.ok(detail.textContent.includes(c), c);
  assert.match(detail.querySelector('.message-text').textContent, /^שלום גדי דמה,/);
  assert.match(detail.textContent, /חופפים/); // his overlap warning
  assert.match(detail.querySelector('.message').textContent, /⚠ שיבוץ כפול/); // preview warning chip
});

test('the old editable message wording is gone', () => {
  assert.equal($('template-form'), null);
  assert.equal(document.querySelector('.template-box'), null);
});

test('problems box: overlaps are listed, notes/merges are not', () => {
  assert.equal($('issues').hidden, false);
  const text = $('issues-body').textContent;
  assert.match(text, /חייל משובץ פעמיים באותו זמן \(2\)/); // גדי דמה overlap + סהר דמה duplicate
  assert.match(text, /גדי דמה/);
  assert.ok(!/אוחדו|דומים|משבצות ריקות|כולל 2 חיילים/.test(text));
  assert.ok(!/נתונים שלא נקראו/.test(text)); // no read errors in this file
});
