// DOM tests (jsdom) for the weekly board and its links to the other views.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import { parseRoster } from '../src/core/index.js';
import { buildMainFixture } from './fixtures/build.js';

const html = fs.readFileSync(path.join(import.meta.dirname, '..', 'public', 'index.html'), 'utf8');
const dom = new JSDOM(html.replace(/<script[^>]*><\/script>/, ''), { url: 'http://localhost/' });
Object.assign(globalThis, { window: dom.window, document: dom.window.document, FormData: dom.window.FormData });
dom.window.HTMLElement.prototype.scrollIntoView = () => {};
const roster = await parseRoster(await buildMainFixture(), { fileName: 'a.xlsx', today: '2026-10-17' });
globalThis.fetch = async (url) => {
  const json = (status, body) => ({ ok: status < 400, status, json: async () => body });
  if (url === '/api/roster') return json(200, roster);
  if (url === '/api/messages/preview') return json(200, { messages: [] });
  throw new Error(`unexpected ${url}`);
};
await import('../public/js/app.js');
await new Promise((r) => setTimeout(r, 20));
const $ = (id) => document.getElementById(id);
const click = (n) => n.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
const change = (n, type = 'change') => n.dispatchEvent(new dom.window.Event(type));
const title = () => $('week-title').textContent;
const rowLabels = () => [...document.querySelectorAll('#week-board .board-pos')].map((th) => th.textContent);

// The real "today" decides the initial week; navigate to the roster week explicitly.
click($('tab-week'));
click($('week-roster'));

test('board opens on the roster week with Sunday-first day headers', () => {
  assert.equal($('view-week').hidden, false);
  assert.equal(title(), 'השבוע 11/10 עד 17/10/2026');
  const heads = [...document.querySelectorAll('#week-board .day-head')].map((b) => b.textContent);
  assert.deepEqual(heads, ['ראשון11/10', 'שני12/10', 'שלישי13/10', 'רביעי14/10', 'חמישי15/10', 'שישי16/10', 'שבת17/10']);
});

test('previous / next week navigation', () => {
  click($('week-next'));
  assert.equal(title(), 'השבוע 18/10 עד 24/10/2026');
  click($('week-next'));
  assert.match($('week-board').textContent, /מחוץ לטווח השיבוץ/);
  click($('week-prev'));
  click($('week-prev'));
  assert.equal(title(), 'השבוע 11/10 עד 17/10/2026');
});

test('post filter options come from the roster and filter the rows', () => {
  const opts = [...$('week-post').options].map((o) => o.textContent);
  assert.ok(opts.includes('סטטיות › מזרחית'));
  $('week-post').value = roster.options.find((g) => g.label === 'סטטיות').id;
  change($('week-post'));
  assert.deepEqual(rowLabels(), ['ש״ג', 'מזרחית']);
  $('week-post').value = 'all';
  change($('week-post'));
  assert.equal(rowLabels().length, 10);
});

test('soldier highlight marks only that soldier’s entries', () => {
  $('week-person').value = 'גדי';
  change($('week-person'), 'input');
  const hits = [...document.querySelectorAll('#week-board .entry-hit .entry-name')].map((n) => n.textContent);
  assert.deepEqual(hits, ['גדי דמה', 'גדי דמה']);
  assert.ok(document.querySelectorAll('#week-board .entry-dim').length > 0);
  assert.match($('week-status').textContent, /מודגשים 2 שיבוצים/);
  $('week-person').value = '';
  change($('week-person'), 'input');
});

test('overlapping assignments are marked ⚠', () => {
  const warned = [...document.querySelectorAll('#week-board .entry-warn .entry-name')].map((n) => n.textContent);
  assert.ok(warned.includes('גדי דמה'));
});

test('clicking an entry shows its details and links to the soldier view', () => {
  const entry = [...document.querySelectorAll('#week-board button.entry')].find((b) => b.textContent.includes('אבי דמה'));
  click(entry);
  const detail = $('week-detail').textContent;
  assert.match(detail, /אבי דמה/);
  assert.match(detail, /סיור › מפקד – סיור/);
  assert.match(detail, /C4/);
  const toSoldier = [...$('week-detail').querySelectorAll('button')].find((b) => b.textContent.startsWith('כל השיבוצים'));
  click(toSoldier);
  assert.equal($('view-soldiers').hidden, false);
  assert.equal($('soldier-filter').value, 'אבי דמה');
  assert.equal(document.querySelector('#soldier-list .soldier-name').getAttribute('aria-expanded'), 'true');
});

test('clicking a day header opens the hour search on that date', () => {
  click($('tab-week'));
  const tue = [...document.querySelectorAll('#week-board .day-head')][2];
  click(tue);
  assert.equal($('view-search').hidden, false);
  assert.match(document.querySelector('#date-picker .dp-value').textContent, /13/);
});

test('shifts tab: optional filters, live results, days only from the file', () => {
  click($('tab-shifts'));
  assert.equal($('view-shifts').hidden, false);
  const dayOpts = [...$('sh-day').options].map((o) => o.textContent);
  assert.equal(dayOpts[0], 'כל הימים');
  assert.equal(dayOpts[1], 'ראשון 11/10');
  assert.equal($('sh-hour').options.length, 25);
  const timed = roster.assignments.filter((a) => a.kind === 'timed').length;
  assert.match($('sh-results').textContent, new RegExp(`נמצאו ${timed} משמרות`));

  $('sh-post').value = roster.options.find((g) => g.label === 'סטטיות').positions.find((p) => p.label === 'מזרחית').id;
  change($('sh-post'));
  $('sh-day').value = '2026-10-12';
  change($('sh-day'));
  $('sh-hour').value = '17';
  change($('sh-hour'));
  const names = [...$('sh-results').querySelectorAll('tbody tr td:first-child strong')].map((n) => n.textContent);
  assert.deepEqual(names, ['עדי דמה', 'פז דמה']);

  $('sh-day').value = '2026-10-17';
  change($('sh-day'));
  assert.match($('sh-results').textContent, /לא נמצאו בקובץ משמרות/);

  click($('sh-reset'));
  assert.match($('sh-results').textContent, new RegExp(`נמצאו ${timed} משמרות`));
});

test('board highlight by any spelling marks all of that soldier’s shifts', () => {
  click($('tab-week'));
  $('week-person').value = 'נוה';
  change($('week-person'), 'input');
  const hits = [...document.querySelectorAll('#week-board .entry-hit .entry-name')].map((n) => n.textContent);
  const expected = roster.assignments.filter((a) => a.person === 'נווה דמה').length;
  assert.equal(hits.length, expected + 1); // the overnight shift shows on two days
  assert.ok(hits.every((n) => n === 'נווה דמה'));
  $('week-person').value = '';
  change($('week-person'), 'input');
});
