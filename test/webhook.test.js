// Status webhook: handshake, signature check, status updates — memory repo, no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import request from 'supertest';
import { createApp } from '../server/app.js';
import { createSessionStore } from '../server/sessions.js';
import { createMemoryRepo } from '../server/repo.js';
import { buildMainFixture } from './fixtures/build.js';

const SECRET = 'סוד-דמה-app';
const VERIFY = 'verify-demo-token';
const W = '2026-10-18';
const quiet = { warn() {}, error() {} };

function setup({ webhook = { appSecret: SECRET, verifyToken: VERIFY }, repo = createMemoryRepo(), log = quiet } = {}) {
  const store = createSessionStore({ idleTtlMs: 3600e3, maxAgeMs: 3600e3 });
  const app = createApp({ store, today: () => '2026-10-17', log, repo, ...(webhook ? { webhook } : {}) });
  return { app, repo };
}
const sign = (raw, secret = SECRET) => 'sha256=' + createHmac('sha256', secret).update(raw).digest('hex');
const payload = (statuses, extra = {}) => JSON.stringify({
  object: 'whatsapp_business_account',
  entry: [{ id: 'waba-demo', changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', metadata: {}, statuses, ...extra } }] }],
});
const post = (app, raw, sig = sign(raw)) =>
  request(app).post('/webhooks/whatsapp').set('Content-Type', 'application/json').set('X-Hub-Signature-256', sig).send(raw);
const status = (id, st, extra = {}) => ({ id, status: st, timestamp: '1700000000', recipient_id: '972500000001', ...extra });

async function seeded() {
  const ctx = setup();
  const base = { weekStart: W, soldierKey: 'k1', soldierName: 'חייל דמה', paramsHash: 'h' };
  await ctx.repo.reserveSend({ ...base, resend: false });
  await ctx.repo.completeSend({ ...base, wamid: 'wamid.demo1', status: 'accepted' });
  return { ...ctx, get: async () => (await ctx.repo.listSends(W)).get('k1') };
}

test('GET handshake: right token → challenge text; wrong token or mode → 403', async () => {
  const { app } = setup();
  const ok = await request(app).get('/webhooks/whatsapp').query({ 'hub.mode': 'subscribe', 'hub.verify_token': VERIFY, 'hub.challenge': '12345' });
  assert.equal(ok.status, 200);
  assert.equal(ok.text, '12345');
  assert.equal((await request(app).get('/webhooks/whatsapp').query({ 'hub.mode': 'subscribe', 'hub.verify_token': 'nope', 'hub.challenge': '1' })).status, 403);
  assert.equal((await request(app).get('/webhooks/whatsapp').query({ 'hub.mode': 'other', 'hub.verify_token': VERIFY, 'hub.challenge': '1' })).status, 403);
  assert.equal((await request(app).get('/webhooks/whatsapp')).status, 403);
});

test('POST with a missing or wrong signature → 401, nothing applied', async () => {
  const { app, get } = await seeded();
  const raw = payload([status('wamid.demo1', 'read')]);
  assert.equal((await request(app).post('/webhooks/whatsapp').set('Content-Type', 'application/json').send(raw)).status, 401);
  assert.equal((await post(app, raw, sign(raw, 'other-secret'))).status, 401);
  assert.equal((await post(app, raw, 'sha256=abc')).status, 401);
  assert.equal((await post(app, raw, sign(raw + ' '))).status, 401);
  assert.equal((await get()).status, 'accepted');
});

test('delivered → read → delivered ends as read', async () => {
  const { app, get } = await seeded();
  for (const st of ['delivered', 'read', 'delivered']) {
    assert.equal((await post(app, payload([status('wamid.demo1', st)]))).status, 200);
  }
  const rec = await get();
  assert.equal(rec.status, 'read');
  assert.equal(rec.statusAt.getTime(), 1700000000e3);
});

test('failed with code 131026 stores the Hebrew reason', async () => {
  const { app, get } = await seeded();
  const s = status('wamid.demo1', 'failed', { errors: [{ code: 131026, title: 'Message undeliverable' }] });
  assert.equal((await post(app, payload([s]))).status, 200);
  const rec = await get();
  assert.equal(rec.status, 'failed');
  assert.equal(rec.error, 'המספר אינו זמין ב־WhatsApp');
});

test('incoming messages payload → 200 and no repo call', async () => {
  const calls = [];
  const repo = { ...createMemoryRepo(), applyStatus: async (a) => { calls.push(a); } };
  const { app } = setup({ repo });
  const raw = payload(undefined, { messages: [{ from: '972500000001', id: 'wamid.in1', type: 'text', text: { body: 'שלום דמה' } }] });
  assert.equal((await post(app, raw)).status, 200);
  assert.equal(calls.length, 0);
});

test('malformed JSON with a valid signature → 200, warning logged without the body', async () => {
  const warnings = [];
  const { app } = setup({ log: { warn: (...a) => warnings.push(a.join(' ')), error() {} } });
  const raw = '{"secret-ish": not json';
  assert.equal((await post(app, raw)).status, 200);
  assert.ok(warnings.length >= 1);
  assert.ok(warnings.every((w) => !w.includes('secret-ish')));
});

test('a repo error on one status → 500 (Meta retries), the other statuses still applied', async () => {
  const mem = createMemoryRepo();
  const repo = { ...mem, applyStatus: async (a) => { if (a.wamid === 'wamid.bad') throw new Error('db down'); return mem.applyStatus(a); } };
  const ctx = setup({ repo });
  const base = { weekStart: W, soldierKey: 'k1', soldierName: 'חייל דמה', paramsHash: 'h' };
  await repo.reserveSend({ ...base, resend: false });
  await repo.completeSend({ ...base, wamid: 'wamid.demo1', status: 'accepted' });
  const res = await post(ctx.app, payload([status('wamid.bad', 'read'), status('wamid.demo1', 'delivered')]));
  assert.equal(res.status, 500);
  assert.equal((await repo.listSends(W)).get('k1').status, 'delivered');
});

test('unknown wamid → 200', async () => {
  const { app } = setup();
  assert.equal((await post(app, payload([status('wamid.unknown', 'read')]))).status, 200);
});

test('non-numeric timestamp falls back to now', async () => {
  const { app, get } = await seeded();
  assert.equal((await post(app, payload([status('wamid.demo1', 'read', { timestamp: 'abc' })]))).status, 200);
  const rec = await get();
  assert.equal(rec.status, 'read');
  assert.ok(Number.isFinite(rec.statusAt.getTime()) && rec.statusAt.getTime() > 1700000000e3);
});

test('webhook not configured → 503 on GET and POST', async () => {
  const { app } = setup({ webhook: null });
  assert.equal((await request(app).get('/webhooks/whatsapp').query({ 'hub.mode': 'subscribe' })).status, 503);
  assert.equal((await request(app).post('/webhooks/whatsapp').set('Content-Type', 'application/json').send('{}')).status, 503);
  const half = setup({ webhook: { appSecret: SECRET } });
  assert.equal((await request(half.app).get('/webhooks/whatsapp')).status, 503);
});

test('webhook configured: JSON API routes still parse their bodies (/api/auth, /api/search)', async () => {
  const store = createSessionStore({ idleTtlMs: 3600e3, maxAgeMs: 3600e3 });
  const repo = createMemoryRepo();
  const wa = { async sendTemplate() { return { ok: true, wamid: 'x' }; }, async templateStatus() { return 'APPROVED'; } };
  const app = createApp({ store, today: () => '2026-10-17', log: quiet, repo, wa, sendCode: 'קוד-דמה', sendEnabled: true, webhook: { appSecret: SECRET, verifyToken: VERIFY } });
  const agent = request.agent(app);
  const up = await agent.post('/api/roster').attach('file', await buildMainFixture(), 'f.xlsx');
  assert.equal(up.status, 201);
  assert.equal((await agent.post('/api/auth').send({ code: 'קוד-דמה' })).status, 204);
  assert.equal((await agent.post('/api/auth').send({ code: 'שגוי' })).status, 401);
  const q = await agent.post('/api/search').send({ rosterVersion: 'old-version' });
  assert.equal(q.status, 409); // body was read (a Buffer body would give a different answer)
  assert.equal(q.body.error, 'stale');
  assert.equal((await post(app, payload([]))).status, 200); // webhook itself needs no session or code
});
