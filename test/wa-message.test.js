import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRoster } from '../src/core/index.js';
import { buildWaMessage, templateBody, MAX_DAYS } from '../src/core/wa-message.js';
import { buildMainFixture } from './fixtures/build.js';

const roster = await parseRoster(await buildMainFixture(), { fileName: 'f.xlsx', today: '2026-10-17' });
const byId = new Map(roster.assignments.map((a) => [a.id, a]));
const WEEK = '2026-10-11';
const soldier = (name) => roster.soldiers.find((s) => s.name === name);
const asg = (s) => s.assignmentIds.map((id) => byId.get(id));
const build = (name, week = WEEK, opts) => { const s = soldier(name); return buildWaMessage(s, asg(s), week, opts); };

const shift = (date, h, id) => ({
  id, kind: 'timed', start: { date, time: `${h}:00` }, end: { date, time: `${h}:30` },
  startKey: Number(date.slice(8)) * 1440 + Number(h) * 60, endKey: Number(date.slice(8)) * 1440 + Number(h) * 60 + 30,
  allDay: false, section: 'א'.repeat(60), position: 'ב'.repeat(60), sharedWith: [],
});
const fake = (assignments, extra = {}) => buildWaMessage({ name: 'חייל דמה', ambiguous: false, ...extra }, assignments, WEEK);

test('name and range params, then one line per day that has a shift', () => {
  const m = build('גדי דמה');
  assert.equal(m.params[0], 'גדי דמה');
  assert.equal(m.params[1], '11/10 עד 18/10');
  assert.equal(m.dayCount, m.params.length - 2);
  assert.ok(m.dayCount >= 1 && m.dayCount <= MAX_DAYS);
  for (const p of m.params.slice(2)) assert.match(p, /^יום (ראשון|שני|שלישי|רביעי|חמישי|שישי|שבת) \d\d\/\d\d: /);
});

test('days without a shift are left out', () => {
  const m = fake([shift('2026-10-12', '08', 'a'), shift('2026-10-14', '10', 'b')]);
  assert.equal(m.dayCount, 2);
  assert.deepEqual(m.params.slice(2).map((p) => p.split(':')[0]), ['יום שני 12/10', 'יום רביעי 14/10']);
  assert.ok(!m.params.some((p) => p.includes('—')));
});

test('the second Sunday is named with its date', () => {
  const m = fake([shift('2026-10-11', '08', 'a'), shift('2026-10-18', '08', 'b')]);
  assert.deepEqual(m.params.slice(2).map((p) => p.split(':')[0]), ['יום ראשון 11/10', 'יום ראשון 18/10']);
});

test('two shifts on one day are joined by " • " in start order', () => {
  const m = build('גדי דמה');
  assert.ok(m.params.includes('יום שני 12/10: 06:00 עד 14:00 · סיור / מפקד – סיור • 08:00 עד 12:00 · סטטיות / ש״ג'), m.params.join('|'));
  assert.equal(m.sendable, true);
});

test('night shift keeps its night label inside the start day line', () => {
  const m = build('לוטם דמה');
  assert.ok(m.params.some((p) => /^יום שני 12\/10: בין יום ראשון 11\/10 לשני 12\/10 · 00:00 עד 04:00/.test(p)), m.params.join('|'));
});

test('params are template-safe and text = body lines for the day count + blank + footer', () => {
  for (const s of roster.soldiers) {
    const m = buildWaMessage(s, asg(s), WEEK);
    for (const p of m.params) assert.ok(!/[\n\t]/.test(p) && !/ {4,}/.test(p), p);
  }
  const m = build('גדי דמה');
  const lines = m.text.split('\n');
  assert.equal(lines.length, m.dayCount + 3 + 2);
  assert.equal(lines.at(-2), '');
  assert.equal(lines.at(-1), 'הודעה אוטומטית ממערכת השיבוץ');
  assert.ok(lines.slice(2, 2 + m.dayCount).every((l) => l.startsWith('• יום ')));
});

test('templateBody(k) has k bullet lines with params {{3}}..{{k+2}}', () => {
  assert.equal(templateBody(1), 'שלום {{1}},\nאלה השיבוצים שלך לפי קובץ השיבוץ לשבוע {{2}}:\n• {{3}}\nאם יש טעות בשיבוץ, פנו למפקד. בהצלחה!');
  assert.ok(templateBody(8).includes('• {{10}}') && !templateBody(8).includes('{{11}}'));
});

test('blocked cases', () => {
  const ok = fake([shift('2026-10-12', '08', 'a')]);
  assert.equal(ok.sendable, true);
  assert.deepEqual(ok.problems, []);
  const bad = (m) => { assert.equal(m.sendable, false); assert.ok(m.problems.length > 0 && m.problems.every((p) => p)); };
  bad(fake([shift('2026-10-12', '08', 'a')], { ambiguous: true }));
  bad(fake([shift('2026-10-12', '08', 'a'), { id: 'x', kind: 'untimed' }]));
  bad(fake([shift('2026-10-10', '08', 'a')]));
  bad(fake([shift('2026-10-19', '08', 'a')]));
  assert.equal(fake([shift('2026-10-18', '08', 'a')]).sendable, true);
  bad(fake([]));
  bad(buildWaMessage({ name: 'חייל דמה', ambiguous: false }, [shift('2026-10-12', '08', 'a')], null));
});

test('body over 1024 chars is blocked', () => {
  const many = Array.from({ length: 8 }, (_, i) => shift('2026-10-12', String(10 + i), `s${i}`));
  const m = fake(many);
  assert.ok(m.text.length > 1024);
  assert.equal(m.sendable, false);
  assert.ok(m.problems.some((p) => p.includes('1024')));
});

test('overlap warns but stays sendable', () => {
  const s = soldier('גדי דמה');
  const as = asg(s);
  const m = buildWaMessage(s, as, WEEK, { overlapIds: new Set([as[0].id]) });
  assert.equal(m.sendable, true);
  assert.ok(m.warnings.some((w) => w.includes('שיבוץ כפול')));
  assert.deepEqual(build('גדי דמה').warnings, []);
});

test('hash is stable and changes with the shifts', () => {
  const s = soldier('גדי דמה');
  const as = asg(s);
  assert.equal(buildWaMessage(s, as, WEEK).hash, buildWaMessage(s, as, WEEK).hash);
  assert.match(buildWaMessage(s, as, WEEK).hash, /^[0-9a-f]{64}$/);
  const changed = [{ ...as[0], section: 'אחר' }, ...as.slice(1)];
  assert.notEqual(buildWaMessage(s, changed, WEEK).hash, buildWaMessage(s, as, WEEK).hash);
});

test('a week that does not start on Sunday is not sendable', () => {
  const m = build('גדי דמה', '2026-10-12');
  assert.equal(m.sendable, false);
  assert.ok(m.problems.includes('תחילת השבוע אינה יום ראשון — לא ניתן לשלוח'));
});
