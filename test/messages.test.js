import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRoster } from '../src/core/index.js';
import { shiftText } from '../src/core/messages.js';
import { rosterMessageBuilder } from '../src/core/wa-message.js';
import { buildMainFixture } from './fixtures/build.js';

const roster = await parseRoster(await buildMainFixture(), { fileName: 'f.xlsx', today: '2026-10-17' });
const byId = new Map(roster.assignments.map((a) => [a.id, a]));
const soldier = (name) => roster.soldiers.find((s) => s.name === name);
// The soldier's shifts as worded in the message, in time order.
const shifts = (name) =>
  soldier(name).assignmentIds.map((id) => byId.get(id)).filter((a) => a.kind === 'timed').sort((x, y) => x.startKey - y.startKey).map(shiftText);
const message = rosterMessageBuilder(roster);

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
    assert.match(shifts(name)[0], new RegExp(`מטבח 1 \\(עיבוי ש"ג\\) \\(יחד עם ${other}\\)`));
  }
  assert.equal(roster.soldiers.find((s) => s.name.includes('/')), undefined);
});

test('message lists exactly the soldier’s assignments, in time order', () => {
  assert.deepEqual(shifts('גדי דמה'), ['06:00 עד 14:00 · סיור / מפקד – סיור', '08:00 עד 12:00 · סטטיות / ש״ג']);
  const m = message(soldier('גדי דמה'));
  assert.ok(m.text.startsWith('שלום גדי דמה,'));
  assert.deepEqual(m.problems, []);
});

test('overnight, midnight-ending, whole-day and multi-day formats (RTL-safe "עד")', () => {
  assert.deepEqual(shifts('אבי דמה'), ['22:00 עד יום שני 12/10 06:00 · סיור / מפקד – סיור']);
  assert.match(shifts('כרם דמה')[0], /^20:00 עד 24:00/);
  assert.match(shifts('קרן דמה')[0], /^כל היום · מטבח \/ מטבח 1/);
  assert.match(shifts('אלון דמה')[0], /^11:00 עד יום ראשון 18\/10 11:00/);
  assert.ok(!/\d–\d/.test(message(soldier('גדי דמה')).text), 'no bare dash between times');
});

test('night shifts say which night: "בין יום X ל־Y" with both dates', () => {
  // לוטם דמה: סטטיות / ש״ג, Monday 12/10 00:00–04:00 → the night between Sunday and Monday
  assert.deepEqual(shifts('לוטם דמה'), ['בין יום ראשון 11/10 לשני 12/10 · 00:00 עד 04:00 · סטטיות / ש״ג']);
  // day shifts have no night label
  assert.match(shifts('גדי דמה')[0], /^06:00 עד 14:00/);
});

test('unresolved assignments block the message; nothing partial is sent', () => {
  const omer = message(soldier('עומר דמה'));
  assert.equal(omer.sendable, false);
  assert.ok(omer.problems.length >= 2);
});

test('a unit ("מחלקה 2") is not a soldier: not listed, not counted, no message', () => {
  assert.ok(roster.assignments.some((a) => a.person === 'מחלקה 2')); // still covers posts
  assert.equal(roster.soldiers.find((s) => s.name === 'מחלקה 2'), undefined);
  assert.equal(roster.summary.soldiers, roster.soldiers.length);
});
