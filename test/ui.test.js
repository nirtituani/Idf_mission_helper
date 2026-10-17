// DOM tests (jsdom) for the date picker and the search form wiring.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import { parseRoster } from '../src/core/index.js';
import { buildMainFixture, buildSecondFixture } from './fixtures/build.js';

const html = fs.readFileSync(path.join(import.meta.dirname, '..', 'public', 'index.html'), 'utf8');
const dom = new JSDOM(html.replace(/<script[^>]*><\/script>/, ''), { url: 'http://localhost/' });
Object.assign(globalThis, { window: dom.window, document: dom.window.document, FormData: dom.window.FormData });
const { DatePicker, monthGrid, shiftMonth } = await import('../public/js/datepicker.js');
const click = (node) => node.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
const key = (node, k) => node.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: k, bubbles: true }));

function mountPicker(opts = {}) {
  const host = document.createElement('div');
  document.body.append(host);
  const changes = [];
  const picker = new DatePicker(host, { value: '2026-10-17', today: '2026-10-17', onChange: (d) => changes.push(d), ...opts });
  return { host, picker, changes };
}

test('monthGrid: Sunday-first, 42 cells, correct month membership', () => {
  const g = monthGrid(2026, 10);
  assert.equal(g.length, 42);
  assert.equal(g[0].iso, '2026-09-27');
  assert.equal(g.find((c) => c.inMonth).iso, '2026-10-01');
  assert.equal(g.filter((c) => c.inMonth).length, 31);
  assert.deepEqual(shiftMonth(2026, 12, 1), { year: 2027, month: 1 });
  assert.deepEqual(shiftMonth(2026, 1, -1), { year: 2025, month: 12 });
});

test('clicking the field opens a calendar with the selected month and today marked', () => {
  const { host } = mountPicker();
  const field = host.querySelector('.dp-field');
  const pop = host.querySelector('.dp-pop');
  assert.equal(pop.hidden, true);
  click(field);
  assert.equal(pop.hidden, false);
  assert.equal(field.getAttribute('aria-expanded'), 'true');
  assert.match(host.querySelector('.dp-month').textContent, /אוקטובר/);
  assert.equal(host.querySelectorAll('.dp-day').length, 42);
  assert.equal(host.querySelector('.dp-selected').dataset.iso, '2026-10-17');
  assert.equal(host.querySelector('.dp-is-today').dataset.iso, '2026-10-17');
});

test('selecting a day updates the value, field text, closes and fires onChange', () => {
  const { host, picker, changes } = mountPicker();
  click(host.querySelector('.dp-field'));
  click(host.querySelector('[data-iso="2026-10-12"]'));
  assert.equal(picker.value, '2026-10-12');
  assert.deepEqual(changes, ['2026-10-12']);
  assert.equal(host.querySelector('.dp-pop').hidden, true);
  assert.match(host.querySelector('.dp-value').textContent, /12/);
});

test('month navigation and the Today button', () => {
  const { host, changes } = mountPicker({ value: '2026-10-12' });
  click(host.querySelector('.dp-field'));
  const [prev, next] = host.querySelectorAll('.dp-nav');
  click(next);
  assert.match(host.querySelector('.dp-month').textContent, /נובמבר/);
  click(prev);
  click(prev);
  assert.match(host.querySelector('.dp-month').textContent, /ספטמבר/);
  click(host.querySelector('.dp-today'));
  assert.deepEqual(changes, ['2026-10-17']);
});

test('keyboard: RTL arrows move days, Enter selects, Escape closes', () => {
  const { host, changes } = mountPicker();
  click(host.querySelector('.dp-field'));
  const grid = host.querySelector('.dp-grid');
  key(grid, 'ArrowLeft'); // next day in RTL
  key(grid, 'ArrowDown'); // +7
  key(grid, 'Enter');
  assert.deepEqual(changes, ['2026-10-25']);
  click(host.querySelector('.dp-field'));
  key(host.querySelector('.dp-pop'), 'Escape');
  assert.equal(host.querySelector('.dp-pop').hidden, true);
});

test('days with roster data are marked', () => {
  const { host } = mountPicker({ markedDates: new Set(['2026-10-12']) });
  click(host.querySelector('.dp-field'));
  assert.deepEqual([...host.querySelectorAll('.dp-has-data')].map((b) => b.dataset.iso), ['2026-10-12']);
});

test('search form: 24 hours, post options only from the roster, replaced on new upload', async () => {
  const r1 = await parseRoster(await buildMainFixture(), { fileName: 'a.xlsx', today: '2026-10-17' });
  const r2 = await parseRoster(await buildSecondFixture(), { fileName: 'b.xlsx', today: '2026-10-17' });
  const responses = [r1, r2];
  let searchBody = null;
  globalThis.fetch = async (url, opts = {}) => {
    const json = (status, body) => ({ ok: status < 400, status, json: async () => body });
    if (url === '/api/roster' && (opts.method || 'GET') === 'GET') return json(404, { error: 'no-roster' });
    if (url === '/api/roster') return json(201, responses.shift());
    if (url === '/api/search') {
      searchBody = JSON.parse(opts.body);
      return json(200, { query: { date: searchBody.date, hour: searchBody.hour, postLabel: null }, status: 'none', range: null, matches: [], dateOnly: [], emptySlots: [], undetermined: [] });
    }
    throw new Error(`unexpected ${url}`);
  };
  await import('../public/js/app.js');
  await tick();
  assert.equal(document.getElementById('search-form').hidden, true);

  const fileInput = document.getElementById('file');
  const upload = async (name) => {
    Object.defineProperty(fileInput, 'files', { configurable: true, value: [new dom.window.File(['x'], name)] });
    fileInput.dispatchEvent(new dom.window.Event('change'));
    await tick();
  };

  await upload('a.xlsx');
  const hours = [...document.querySelectorAll('#hour option')].map((o) => o.textContent);
  assert.equal(hours.length, 24);
  assert.equal(hours[0], '00:00');
  assert.equal(hours[23], '23:00');

  const postTexts = () => [...document.querySelectorAll('#post option')].map((o) => o.textContent);
  const groups = () => [...document.querySelectorAll('#post optgroup')].map((g) => g.label);
  assert.deepEqual(groups(), ['סיור', 'סטטיות', 'מטבח', 'מוצב', 'חמ"ל']);
  assert.ok(postTexts().includes('סטטיות › מזרחית'));
  assert.equal(postTexts()[0], 'כל העמדות והתפקידים');
  const expectedCount = 1 + r1.options.reduce((n, g) => n + 1 + g.positions.length, 0);
  assert.equal(postTexts().length, expectedCount);

  // Date picker drives search state.
  click(document.querySelector('#date-picker .dp-field'));
  click(document.querySelector('#date-picker [data-iso="2026-10-12"]'));
  document.getElementById('hour').value = '18';
  document.getElementById('hour').dispatchEvent(new dom.window.Event('change'));
  document.getElementById('post').value = r1.options[1].positions[1].id;
  document.getElementById('search-form').dispatchEvent(new dom.window.Event('submit', { cancelable: true }));
  await tick();
  assert.deepEqual(searchBody, { date: '2026-10-12', hour: 18, postId: r1.options[1].positions[1].id, rosterVersion: r1.version });
  assert.match(document.getElementById('results').textContent, /לא נמצא בקובץ שיבוץ מתאים/);

  await upload('b.xlsx');
  assert.deepEqual(groups(), ['שמירה']);
  assert.ok(!postTexts().some((t) => t.includes('סטטיות')));
  assert.equal(document.getElementById('post').value, 'all');
  assert.equal(document.getElementById('results').textContent, '');
});

const tick = () => new Promise((r) => setTimeout(r, 20));
