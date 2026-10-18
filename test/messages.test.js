import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRoster } from '../src/core/index.js';
import { buildMessage, validateTemplate, TemplateError, DEFAULT_TEMPLATE } from '../src/core/messages.js';
import { buildMainFixture } from './fixtures/build.js';

const roster = await parseRoster(await buildMainFixture(), { fileName: 'f.xlsx', today: '2026-10-17' });
const byId = new Map(roster.assignments.map((a) => [a.id, a]));
const soldier = (name) => roster.soldiers.find((s) => s.name === name);
const message = (name, tpl) => {
  const s = soldier(name);
  return buildMessage(s, s.assignmentIds.map((id) => byId.get(id)), tpl);
};

test('soldiers: one entry per merged identity, all spellings kept, Hebrew-sorted', () => {
  const nava = roster.soldiers.filter((s) => s.spellings.includes('נווה דמה') || s.spellings.includes('נוה דמה'));
  assert.equal(nava.length, 1);
  assert.deepEqual(nava[0].spellings.sort(), ['נווה דמה', 'נוה דמה'].sort());
  const names = roster.soldiers.map((s) => s.name);
  assert.deepEqual(names, [...names].sort((a, b) => a.localeCompare(b, 'he')));
  const personShifts = roster.assignments.filter((a) => a.person !== 'מחלקה 2').length; // units are not soldiers
  assert.equal(roster.soldiers.reduce((n, s) => n + s.assignmentIds.length, 0), personShifts);
});

test('a cell with two names becomes a shared shift for each soldier', () => {
  for (const [name, other] of [['רון דמה', 'שי דמה'], ['שי דמה', 'רון דמה']]) {
    assert.equal(soldier(name).ambiguous, false);
    assert.match(message(name).text, new RegExp(`מטבח 1 \\(עיבוי ש"ג\\) \\(יחד עם ${other}\\)`));
  }
  assert.equal(roster.soldiers.find((s) => s.name.includes('/')), undefined);
});

test('message lists exactly the soldier’s assignments, in time order', () => {
  const m = message('גדי דמה');
  const lines = m.text.split('\n').filter((l) => l.startsWith('•'));
  assert.equal(lines.length, soldier('גדי דמה').timedCount);
  assert.deepEqual(lines, [
    '• יום שני 12/10 · 06:00 עד 14:00 · סיור / מפקד – סיור',
    '• יום שני 12/10 · 08:00 עד 12:00 · סטטיות / ש״ג',
  ]);
  assert.ok(m.text.startsWith('שלום גדי דמה,'));
  assert.deepEqual(m.problems, []);
});

test('overnight, midnight-ending, whole-day and multi-day formats (RTL-safe "עד")', () => {
  assert.match(message('אבי דמה').text, /• יום ראשון 11\/10 · 22:00 עד יום שני 12\/10 06:00 · סיור \/ מפקד – סיור/);
  assert.match(message('כרם דמה').text, /20:00 עד 24:00/);
  assert.match(message('קרן דמה').text, /• יום ראשון 11\/10 · כל היום · מטבח \/ מטבח 1/);
  assert.match(message('אלון דמה').text, /• יום שלישי 13\/10 · 11:00 עד יום ראשון 18\/10 11:00/);
  assert.ok(!/\d–\d/.test(message('גדי דמה').text), 'no bare dash between times');
});

test('night shifts say which night: "בין יום X ל־Y" with both dates', () => {
  // לוטם דמה: סטטיות / ש״ג, Monday 12/10 00:00–04:00 → the night between Sunday and Monday
  assert.match(message('לוטם דמה').text, /^• בין יום ראשון 11\/10 לשני 12\/10 · 00:00 עד 04:00 · סטטיות \/ ש״ג$/m);
  // day shifts keep the plain day label
  assert.match(message('גדי דמה').text, /^• יום שני 12\/10 · 06:00 עד 14:00/m);
});

test('template placeholders and empty lines', () => {
  const m = message('גדי דמה', { greeting: 'היי {שם}', intro: '', closing: 'שבוע {טווח}' });
  const lines = m.text.split('\n');
  assert.equal(lines[0], 'היי גדי דמה');
  assert.equal(lines[1].startsWith('•'), true);
  assert.equal(lines.at(-1), 'שבוע 12/10 עד 12/10');
});

test('unresolved assignments are excluded and reported; ambiguous cells get a problem', () => {
  const omer = message('עומר דמה');
  assert.equal(omer.included, 0);
  assert.equal(omer.excluded.length, 1);
  assert.ok(omer.problems.length >= 2);
});

test('template validation', () => {
  assert.deepEqual(validateTemplate({ greeting: '  שלום\n{שם} ', intro: 'x', closing: '' }), { greeting: 'שלום {שם}', intro: 'x', closing: '' });
  assert.throws(() => validateTemplate({ greeting: 'א'.repeat(301) }), TemplateError);
  assert.throws(() => validateTemplate({ greeting: 5 }), TemplateError);
  assert.throws(() => validateTemplate(null), TemplateError);
  assert.equal(Object.isFrozen(DEFAULT_TEMPLATE), true);
});

test('a unit ("מחלקה 2") is not a soldier: not listed, not counted, no message', () => {
  assert.ok(roster.assignments.some((a) => a.person === 'מחלקה 2')); // still covers posts
  assert.equal(roster.soldiers.find((s) => s.name === 'מחלקה 2'), undefined);
  assert.equal(roster.summary.soldiers, roster.soldiers.length);
});
