import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRoster } from '../src/core/index.js';
import { buildMainFixture, buildSecondFixture, buildBrokenTimesFixture } from './fixtures/build.js';

const TODAY = '2026-10-17';
const parse = async (buf, extra = {}) => parseRoster(buf, { fileName: 'f.xlsx', today: TODAY, ...extra });
const codes = (r) => r.issues.map((i) => i.code);
const find = (r, name) => r.assignments.filter((a) => a.soldier === name);

test('week start is detected from the explicit date cell, with its source', async () => {
  const r = await parse(await buildMainFixture());
  assert.equal(r.weekStart.date, '2026-10-11');
  assert.equal(r.weekStart.source, 'workbook');
  assert.match(r.weekStart.cell, /^שיבוץ!A\d+$/);
});

test('post/role options are exactly the tables and columns in the workbook', async () => {
  const r = await parse(await buildMainFixture());
  const flat = r.options.map((g) => [g.label, g.positions.map((p) => p.label)]);
  assert.deepEqual(flat, [
    ['סיור', ['מפקד – סיור', 'לוחם – סיור']],
    ['סטטיות', ['ש״ג', 'מזרחית']],
    ['מטבח', ['מטבח 1 (עיבוי ש"ג)', 'מטבח 2']],
    ['מוצב', ['מפקד', 'לוחם 1']],
    ['חמ"ל', ['חמליסט', 'רץ חמ"ל']],
  ]);
});

test('no option comes from outside the workbook (side table, plausible extras)', async () => {
  const r = await parse(await buildMainFixture());
  const labels = r.options.flatMap((g) => [g.label, ...g.positions.map((p) => p.label)]);
  for (const notInFile of ['שער', 'שער אחורי', 'תצפית', 'מחסום', 'שמירה', 'ראשון-שלישי', 'כוננות']) {
    assert.ok(!labels.includes(notInFile), `unexpected option ${notInFile}`);
  }
});

test('a different workbook yields only its own options', async () => {
  const r = await parse(await buildSecondFixture());
  assert.deepEqual(r.options.map((g) => [g.label, g.positions.map((p) => p.label)]), [['שמירה', ['עמדה צפונית']]]);
});

test('day names map to consecutive dates; overnight shifts end the next day', async () => {
  const r = await parse(await buildMainFixture());
  const [avi] = find(r, 'אבי דמה');
  assert.deepEqual([avi.start, avi.end], [{ date: '2026-10-11', time: '22:00' }, { date: '2026-10-12', time: '06:00' }]);
  const [ziv] = find(r, 'זיו דמה');
  assert.deepEqual([ziv.start.date, ziv.end.date], ['2026-10-12', '2026-10-13']);
  const [keren] = find(r, 'כרם דמה');
  assert.deepEqual([keren.start, keren.end], [{ date: '2026-10-11', time: '20:00' }, { date: '2026-10-12', time: '00:00' }]);
  assert.equal(avi.source.cell, 'C4');
  assert.equal(avi.source.day, 'A3');
});

test('source labels are preserved, whitespace trimmed', async () => {
  const r = await parse(await buildMainFixture());
  assert.ok(r.assignments.some((a) => a.section === 'חמ"ל'));
  assert.ok(r.assignments.some((a) => a.position === 'ש״ג'));
  assert.equal(find(r, 'זיו דמה').length, 1);
});

test('table without hours (kitchen) = whole-day duty 00:00–24:00', async () => {
  const r = await parse(await buildMainFixture());
  const [keren] = find(r, 'קרן דמה');
  assert.equal(keren.kind, 'timed');
  assert.equal(keren.allDay, true);
  assert.deepEqual([keren.start, keren.end], [{ date: '2026-10-11', time: '00:00' }, { date: '2026-10-12', time: '00:00' }]);
  assert.ok(codes(r).includes('WHOLE_DAY_BLOCK'));
});

test('a name without a task is ignored (info only), not an assignment', async () => {
  const r = await parse(await buildMainFixture());
  assert.equal(find(r, 'נטע דמה').length, 0);
  const issue = r.issues.find((i) => i.code === 'MISSING_TASK');
  assert.equal(issue.level, 'info');
});

test('date ranges: explicit, day-name continuation, and non-continuable', async () => {
  const r = await parse(await buildMainFixture());
  const [or] = find(r, 'אור דמה');
  assert.deepEqual([or.kind, or.start, or.end], ['timed', { date: '2026-10-11', time: '00:00' }, { date: '2026-10-13', time: '11:00' }]);
  // "שלישי עד ראשוון" continues from 13/10 11:00 and ends Sunday 18/10 at the same hour.
  const [alon] = find(r, 'אלון דמה');
  assert.deepEqual([alon.kind, alon.start, alon.end], ['timed', { date: '2026-10-13', time: '11:00' }, { date: '2026-10-18', time: '11:00' }]);
  assert.ok(r.issues.some((i) => i.code === 'RANGE_INFERRED' && i.message.includes('13/10 11:00 עד 18/10 11:00')));
  // "רביעי עד שבת" can't continue from Sunday 18/10 → unresolved, never guessed.
  const [omer] = find(r, 'עומר דמה');
  assert.equal(omer.kind, 'unresolved');
  assert.ok(r.issues.find((i) => i.code === 'UNRESOLVED_RANGE').assignmentIds.includes(omer.id));
});

test('validation: overlap, duplicate, annotations, similar names, empty slots, stray region', async () => {
  const r = await parse(await buildMainFixture());
  const c = codes(r);
  assert.ok(!r.issues.some((i) => i.code === 'OVERLAP' && i.message.includes('מחלקה 2'))); // a unit on two posts is fine
  const overlap = r.issues.find((i) => i.code === 'OVERLAP');
  assert.ok(overlap && overlap.message.includes('גדי דמה'));
  assert.ok(r.issues.some((i) => i.code === 'DUPLICATE' && i.message.includes('סהר דמה')));
  const marks = r.issues.filter((i) => i.code === 'NAME_ANNOTATION');
  assert.deepEqual(marks.map((i) => i.level), ['info']); // "ליאור דמה*"
  assert.ok(c.includes('EMPTY_SLOT'));
  const region = r.issues.find((i) => i.code === 'UNPARSED_REGION');
  assert.deepEqual(region.cells, ['שיבוץ!V12:V13']);
  assert.equal(region.level, 'info');
  assert.equal(r.summary.issues.error, 0);
});

test('near-identical names are merged into one soldier; source spelling kept', async () => {
  const r = await parse(await buildMainFixture());
  const navas = r.assignments.filter((a) => a.soldier === 'נווה דמה' || a.soldier === 'נוה דמה');
  assert.equal(navas.length, 2);
  assert.equal(new Set(navas.map((a) => a.personKey)).size, 1);
  assert.deepEqual(navas.map((a) => a.soldier).sort(), ['נווה דמה', 'נוה דמה'].sort());
  assert.ok(r.issues.some((i) => i.code === 'NAMES_MERGED' && i.message.includes('נוה דמה')));
});

test('two names in one cell → one assignment each, same shift, marked shared', async () => {
  const r = await parse(await buildMainFixture());
  const [ron] = find(r, 'רון דמה');
  const [shai] = find(r, 'שי דמה');
  assert.deepEqual([ron.startKey, ron.position, ron.source.cell], [shai.startKey, shai.position, shai.source.cell]);
  assert.deepEqual([ron.sharedWith, shai.sharedWith], [['שי דמה'], ['רון דמה']]);
  assert.equal(ron.source.cellText, 'רון דמה/שי דמה');
  assert.ok(r.issues.some((i) => i.code === 'SHARED_CELL' && i.level === 'info'));
});

test('(note) in a cell is kept as a note; the soldier is the name outside it', async () => {
  const r = await parse(await buildMainFixture());
  const [tom] = find(r, 'תום דמה');
  assert.equal(tom.note, 'החלפה');
  assert.equal(tom.source.cellText, 'תום דמה(החלפה)');
  assert.ok(r.issues.some((i) => i.code === 'CELL_NOTE' && i.level === 'info'));
});

test('a short form matching exactly one soldier is merged with them', async () => {
  const r = await parse(await buildMainFixture());
  const [chen] = find(r, 'חן');
  assert.equal(chen.person, 'חן דמה');
  assert.ok(!r.issues.some((i) => i.code === 'SIMILAR_NAMES'));
});

test('without any explicit date, day names stay undated until the user picks a week start', async () => {
  const buf = await buildMainFixture({ withExplicitDates: false });
  const r = await parse(buf);
  assert.equal(r.weekStart?.date ?? null, '2026-10-11'); // the outpost range still has dates
  const noDates = await parse(await buildSecondFixture());
  assert.equal(noDates.weekStart.date, '2026-10-18');
});

test('week start missing entirely → error, nothing dated; override fixes it', async () => {
  const ExcelJS = (await import('exceljs')).default;
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('a');
  ws.getCell('A1').value = 'סיור';
  ['יום', 'שעות', 'מפקד'].forEach((h, i) => (ws.getCell(2, i + 1).value = h));
  ws.getCell('A3').value = 'שני';
  ws.getCell('B3').value = '08:00-12:00';
  ws.getCell('C3').value = 'אבי דמה';
  const buf = Buffer.from(await wb.xlsx.writeBuffer());
  const r = await parse(buf);
  assert.equal(r.weekStart, null);
  assert.ok(codes(r).includes('NO_WEEK_START'));
  assert.equal(r.summary.timed, 0);
  const fixed = await parse(buf, { weekStartOverride: '2026-10-11' });
  assert.equal(fixed.weekStart.source, 'user');
  assert.deepEqual(fixed.assignments[0].start, { date: '2026-10-12', time: '08:00' });
});

test('malformed times and days are errors, assignments unresolved', async () => {
  const r = await parse(await buildBrokenTimesFixture());
  const c = codes(r);
  for (const code of ['INVALID_TIME', 'ZERO_DURATION', 'MISSING_TIME', 'INVALID_DAY']) assert.ok(c.includes(code), code);
  assert.equal(r.summary.timed, 0);
  assert.equal(r.summary.unresolved, 4);
  const inv = r.issues.find((i) => i.code === 'INVALID_TIME');
  assert.equal(inv.assignmentIds.length, 1);
});

test('garbage bytes are rejected by the parser', async () => {
  await assert.rejects(parse(Buffer.from('PK not really a zip')));
});
