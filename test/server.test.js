import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import request from 'supertest';
import { createApp } from '../server/app.js';
import { createSessionStore } from '../server/sessions.js';
import { buildMainFixture, buildSecondFixture } from './fixtures/build.js';

const HOUR = 3600e3;
const quiet = { warn() {}, error() {} };
const main = await buildMainFixture();
const second = await buildSecondFixture();

function setup(clock = { t: 0 }) {
  const store = createSessionStore({ idleTtlMs: 8 * HOUR, maxAgeMs: 24 * HOUR, now: () => clock.t });
  const app = createApp({ store, today: () => '2026-10-17', log: quiet });
  return { app, store, clock };
}
const upload = (agent, buf, name = 'שבצק שבוע.xlsx') => agent.post('/api/roster').attach('file', buf, name);

test('upload returns the parsed roster, Hebrew filename intact, HttpOnly cookie, no file bytes', async () => {
  const { app } = setup();
  const res = await upload(request(app), main);
  assert.equal(res.status, 201);
  assert.equal(res.body.fileName, 'שבצק שבוע.xlsx');
  assert.ok(res.body.options.length > 0);
  assert.equal(res.body.buffer, undefined);
  const cookie = res.headers['set-cookie'][0];
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);
});

test('one session cannot read or search another session’s roster', async () => {
  const { app } = setup();
  const a = request.agent(app);
  const b = request.agent(app);
  const up = await upload(a, main);
  assert.equal((await a.get('/api/roster')).status, 200);
  assert.equal((await b.get('/api/roster')).status, 404);
  const search = await b.post('/api/search').send({ date: '2026-10-12', hour: 9, postId: 'all', rosterVersion: up.body.version });
  assert.equal(search.status, 404);
});

test('forged or malformed session tokens are rejected', async () => {
  const { app } = setup();
  await upload(request.agent(app), main);
  for (const token of ['x', 'A'.repeat(43), '../../etc', 'a'.repeat(500)]) {
    const res = await request(app).get('/api/roster').set('Cookie', `roster_sid=${token}`);
    assert.equal(res.status, 404, token);
  }
});

test('sessions expire after idle time and are removed from memory', async () => {
  const { app, store, clock } = setup();
  const a = request.agent(app);
  await upload(a, main);
  clock.t += 7 * HOUR;
  assert.equal((await a.get('/api/roster')).status, 200);
  clock.t += 8 * HOUR + 1;
  assert.equal((await a.get('/api/roster')).status, 404);
  assert.equal(store.size(), 0);
});

test('sessions expire at max age even when active; sweep clears idle ones', async () => {
  const { app, store, clock } = setup();
  const a = request.agent(app);
  await upload(a, main);
  for (let i = 0; i < 5; i++) {
    clock.t += 6 * HOUR;
    await a.get('/api/roster');
  }
  assert.equal((await a.get('/api/roster')).status, 404);
  await upload(request.agent(app), main);
  clock.t += 9 * HOUR;
  assert.equal(store.sweep(), 1);
  assert.equal(store.size(), 0);
});

test('explicit delete removes the roster on the server', async () => {
  const { app, store } = setup();
  const a = request.agent(app);
  await upload(a, main);
  assert.equal((await a.delete('/api/session')).status, 204);
  assert.equal((await a.get('/api/roster')).status, 404);
  assert.equal(store.size(), 0);
});

test('search end-to-end: Monday 17:00 at מזרחית', async () => {
  const { app } = setup();
  const a = request.agent(app);
  const up = await upload(a, main);
  const g = up.body.options.find((x) => x.label === 'סטטיות');
  const postId = g.positions.find((p) => p.label === 'מזרחית').id;
  const res = await a.post('/api/search').send({ date: '2026-10-12', hour: 17, postId, rosterVersion: up.body.version });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.matches.map((m) => m.soldier), ['עדי דמה', 'פז דמה']);
});

test('a new upload replaces options entirely; old option ids/version are refused', async () => {
  const { app } = setup();
  const a = request.agent(app);
  const first = await upload(a, main);
  const second_ = await upload(a, second, 'week2.xlsx');
  assert.deepEqual(second_.body.options.map((g) => g.label), ['שמירה']);
  const roster = (await a.get('/api/roster')).body;
  assert.equal(roster.fileName, 'week2.xlsx');
  assert.ok(!JSON.stringify(roster).includes('סטטיות'));
  const stale = await a.post('/api/search').send({ date: '2026-10-12', hour: 9, postId: 'all', rosterVersion: first.body.version });
  assert.equal(stale.status, 409);
});

test('non-xlsx and corrupt files are refused; previous roster kept', async () => {
  const { app } = setup();
  const a = request.agent(app);
  await upload(a, main);
  assert.equal((await upload(a, Buffer.from('hello'), 'x.csv')).status, 400);
  assert.equal((await upload(a, Buffer.from('PK\u0003\u0004garbage'), 'bad.xlsx')).status, 422);
  assert.equal((await a.get('/api/roster')).body.fileName, 'שבצק שבוע.xlsx');
});

test('week start override re-parses the stored workbook', async () => {
  const { app } = setup();
  const a = request.agent(app);
  await upload(a, main);
  const res = await a.put('/api/roster/week-start').send({ date: '2026-10-04' });
  assert.equal(res.status, 200);
  assert.equal(res.body.weekStart.source, 'user');
  assert.equal((await a.put('/api/roster/week-start').send({ date: 'nope' })).status, 400);
  const reset = await a.put('/api/roster/week-start').send({ date: null });
  assert.equal(reset.body.weekStart.source, 'workbook');
});

test('client bundle contains no server secrets or env access', () => {
  const pub = path.join(import.meta.dirname, '..', 'public');
  const files = fs.readdirSync(pub, { recursive: true }).filter((f) => /\.(js|html|css)$/.test(f));
  for (const f of files) {
    const src = fs.readFileSync(path.join(pub, f), 'utf8');
    // Env-style secret names, token fields, auth headers — not the visible word "WhatsApp".
    assert.ok(!/process\.env|WHATSAPP_[A-Z]|META_[A-Z]|access_token|app_secret|Bearer\s/.test(src), f);
  }
});

test('upgrade-insecure-requests only in production (Safari on http://localhost)', async () => {
  const dev = createApp({ store: createSessionStore({ idleTtlMs: HOUR, maxAgeMs: HOUR }), log: quiet });
  const prod = createApp({ store: createSessionStore({ idleTtlMs: HOUR, maxAgeMs: HOUR }), log: quiet, secureCookies: true });
  assert.ok(!(await request(dev).get('/')).headers['content-security-policy'].includes('upgrade-insecure-requests'));
  assert.ok((await request(prod).get('/')).headers['content-security-policy'].includes('upgrade-insecure-requests'));
});

test('security headers are set', async () => {
  const { app } = setup();
  const res = await request(app).get('/');
  assert.equal(res.status, 200);
  assert.match(res.headers['content-security-policy'], /script-src 'self'/);
  assert.equal(res.headers['x-powered-by'], undefined);
});

test('message preview: per-session, version-checked, the exact WhatsApp template message', async () => {
  const { app } = setup();
  const a = request.agent(app);
  const b = request.agent(app);
  const up = await upload(a, main);
  const key = up.body.soldiers.find((s) => s.name === 'גדי דמה').key;
  const body = { personKeys: [key], rosterVersion: up.body.version };

  const res = await a.post('/api/messages/preview').send(body);
  assert.equal(res.status, 200);
  const [msg] = res.body.messages;
  assert.equal(msg.name, 'גדי דמה');
  assert.match(msg.text, /^שלום גדי דמה,\nאלה השיבוצים שלך לפי קובץ השיבוץ לשבוע 11\/10 עד 18\/10:\n/);
  assert.match(msg.text, /\n• יום שני 12\/10: 06:00 עד 14:00 · סיור \/ מפקד – סיור • 08:00 עד 12:00 · סטטיות \/ ש״ג\n/);
  assert.deepEqual(msg.problems, []);
  assert.equal(msg.warnings.length, 1); // his double booking
  assert.equal(msg.sendable, true);
  assert.equal(msg.params, undefined);
  assert.equal((await b.post('/api/messages/preview').send(body)).status, 404);
  assert.equal((await a.post('/api/messages/preview').send({ ...body, rosterVersion: 'old' })).status, 409);
  assert.equal((await a.post('/api/messages/preview').send({ ...body, personKeys: ['לא קיים'] })).status, 400);
  assert.equal((await a.post('/api/messages/preview').send({ ...body, personKeys: [] })).status, 400);
  // the old editable-template endpoints are gone
  assert.equal((await a.get('/api/messages/template')).status, 404);
});

test('message preview follows the week-start override', async () => {
  const { app } = setup();
  const a = request.agent(app);
  await upload(a, main);
  const roster = (await a.put('/api/roster/week-start').send({ date: '2026-10-04' })).body;
  const key = roster.soldiers.find((s) => s.name === 'גדי דמה').key;
  const [msg] = (await a.post('/api/messages/preview').send({ personKeys: [key], rosterVersion: roster.version })).body.messages;
  assert.match(msg.text, /לשבוע 04\/10 עד 11\/10:/);
  assert.match(msg.text, /\n• יום שני 05\/10: 06:00 עד 14:00/); // day-name shifts move with the week
});

test('uploads are rate-limited per client', async () => {
  const store = createSessionStore({ idleTtlMs: HOUR, maxAgeMs: HOUR });
  const app = createApp({ store, today: () => '2026-10-17', log: quiet, limits: { uploadsPer10Min: 2, apiPerMinute: 1000 } });
  const a = request.agent(app);
  assert.equal((await upload(a, main)).status, 201);
  assert.equal((await upload(a, main)).status, 201);
  const third = await upload(a, main);
  assert.equal(third.status, 429);
  assert.equal(third.body.error, 'rate');
});

test('API requests are rate-limited per client', async () => {
  const store = createSessionStore({ idleTtlMs: HOUR, maxAgeMs: HOUR });
  const app = createApp({ store, log: quiet, limits: { uploadsPer10Min: 100, apiPerMinute: 3 } });
  const codes = [];
  for (let i = 0; i < 4; i++) codes.push((await request(app).get('/api/health')).status);
  assert.deepEqual(codes, [200, 200, 200, 429]);
});

test('when the session cap is reached new visitors get 503, existing ones keep working', async () => {
  const clock = { t: 0 };
  const store = createSessionStore({ idleTtlMs: HOUR, maxAgeMs: 2 * HOUR, maxSessions: 1, now: () => clock.t });
  const app = createApp({ store, today: () => '2026-10-17', log: quiet });
  const first = request.agent(app);
  assert.equal((await upload(first, main)).status, 201);
  const second = await upload(request.agent(app), main);
  assert.equal(second.status, 503);
  assert.equal(second.body.error, 'busy');
  assert.equal((await upload(first, main)).status, 201); // same session re-uploads fine
  clock.t += HOUR + 1; // first session expires → room again
  assert.equal((await upload(request.agent(app), main)).status, 201);
});

test('kept out of search engines', async () => {
  const { app } = setup();
  const page = await request(app).get('/');
  assert.equal(page.headers['x-robots-tag'], 'noindex, nofollow');
  assert.match(page.text, /<meta name="robots" content="noindex, nofollow">/);
  assert.equal((await request(app).get('/robots.txt')).text, 'User-agent: *\nAllow: /privacy\nAllow: /privacy.html\nDisallow: /\n');
});
