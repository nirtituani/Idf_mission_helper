import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTimeRange, parseDayLabel, resolveYear, weekdayOf, nextWeekdayOnOrAfter, parseTimeOfDay } from '../src/core/dates.js';
import { matchKey, cleanText } from '../src/core/text.js';

test('time ranges: same day, overnight, 24:00, half hours', () => {
  assert.deepEqual(parseTimeRange('16:00-20:00'), { startMin: 960, durationMin: 240 });
  assert.deepEqual(parseTimeRange('22:00-06:00'), { startMin: 1320, durationMin: 480 });
  assert.deepEqual(parseTimeRange('20:00-24:00'), { startMin: 1200, durationMin: 240 });
  assert.deepEqual(parseTimeRange('17:30-05:30'), { startMin: 1050, durationMin: 720 });
  assert.deepEqual(parseTimeRange('22:00 – 05:30'), { startMin: 1320, durationMin: 450 });
});

test('time ranges: invalid and zero duration are errors, never guessed', () => {
  assert.deepEqual(parseTimeRange('10:00-10:00'), { error: 'zero-duration' });
  assert.equal(parseTimeRange('25:00-03:00').error, 'format');
  assert.equal(parseTimeRange('בוקר').error, 'format');
  assert.equal(parseTimeRange('24:00-02:00').error, 'format');
  assert.equal(parseTimeOfDay('12:60'), null);
});

test('day labels', () => {
  assert.deepEqual(parseDayLabel('ראשון'), { weekday: 0 });
  assert.deepEqual(parseDayLabel('שלישי 13/10'), { weekday: 2, day: 13, month: 10 });
  assert.deepEqual(parseDayLabel('יום שבת 17.10.2026'), { weekday: 6, day: 17, month: 10, year: 2026 });
  assert.equal(parseDayLabel('ראשוון'), null);
  assert.equal(parseDayLabel('יומיים'), null);
});

test('year resolution requires the weekday to match', () => {
  assert.equal(resolveYear({ weekday: 0, day: 11, month: 10 }, '2026-10-17'), '2026-10-11');
  assert.equal(resolveYear({ weekday: 1, day: 11, month: 10 }, '2026-10-17'), null);
  assert.equal(resolveYear({ weekday: 0, day: 3, month: 1 }, '2026-10-17'), '2027-01-03');
  assert.equal(resolveYear({ weekday: 6, day: 11, month: 10, year: 2025 }, '2026-10-17'), '2025-10-11');
  assert.equal(weekdayOf('2026-10-11'), 0);
  assert.equal(nextWeekdayOnOrAfter('2026-10-11', 2), '2026-10-13');
  assert.equal(nextWeekdayOnOrAfter('2026-10-11', 0), '2026-10-11');
});

test('normalization is explicit: whitespace + typographic equivalents only', () => {
  assert.equal(cleanText('  אבי   דמה '), 'אבי דמה');
  assert.equal(matchKey('ש״ג'), matchKey('ש"ג'));
  assert.notEqual(matchKey('ש"ג'), matchKey('שער'));
  assert.notEqual(matchKey('שער'), matchKey('שער ראשי'));
});

test('night shifts: start 00:00–06:00 and end by 08:00 → between the previous day and this one', async () => {
  const { nightBetween, minuteKey } = await import('../src/core/dates.js');
  const shift = (date, from, to) => ({ start: { date }, startKey: minuteKey(date, from * 60), endKey: minuteKey(date, to * 60) });
  // Friday 16/10 00:00–04:00 → between Thursday and Friday
  assert.deepEqual(nightBetween(shift('2026-10-16', 0, 4)), { fromDay: 'חמישי', toDay: 'שישי', fromDate: '2026-10-15', toDate: '2026-10-16' });
  assert.equal(nightBetween(shift('2026-10-16', 4, 8)).fromDay, 'חמישי');
  assert.equal(nightBetween(shift('2026-10-11', 0, 4)).fromDay, 'שבת'); // Sunday 00:00 → between Saturday and Sunday
  assert.equal(nightBetween(shift('2026-10-16', 5.5, 17.5)), null); // morning shift, not a night shift
  assert.equal(nightBetween(shift('2026-10-16', 6, 14)), null);
  assert.equal(nightBetween(shift('2026-10-16', 22, 30)), null); // 22:00–06:00 starts in the evening
  assert.equal(nightBetween({ ...shift('2026-10-16', 0, 24), allDay: true }), null);
});
