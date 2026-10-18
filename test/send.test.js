// Access code, contacts upload and WhatsApp send routes — memory repo + fake WhatsApp client.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import request from 'supertest';
import { createApp } from '../server/app.js';
import { createSessionStore } from '../server/sessions.js';
import { createMemoryRepo } from '../server/repo.js';
import { loadConfig } from '../server/config.js';
import { parseRoster } from '../src/core/index.js';
import { buildWaMessage } from '../src/core/wa-message.js';
import { buildMainFixture, buildContactsFixture } from './fixtures/build.js';

const HOUR = 3600e3;
const CODE = 'קוד-דמה-1234';
const TEST_PHONE = '972500000099';
const quiet = { warn() {}, error() {} };
const main = await buildMainFixture();
const roster = await parseRoster(main, { fileName: 'f.xlsx', today: '2026-10-17' });
const contactsXlsx = await buildContactsFixture([
  ['גדי דמה', '050-0000001'],
  ['עומר דמה', '050-0000002'],
  ['אבי דמה', '0500000003'],
]);

function fakeWa({ status = 'APPROVED', fail = false } = {}) {
  const wa = {
    calls: [],
    status,
    async sendTemplate(to, params) {
      wa.calls.push({ to, params });
      await new Promise((r) => setImmediate(r));
      return fail ? { ok: false, error: 'שגיאת Meta (קוד 1)' } : { ok: true, wamid: `wamid.test${wa.calls.length}` };
    },
    async templateStatus() {
      return wa.status;
    },
  };
  return wa;
}

function setup({ enabled = true, testPhone = TEST_PHONE, wa = fakeWa(), limits } = {}) {
  const store = createSessionStore({ idleTtlMs: 8 * HOUR, maxAgeMs: 24 * HOUR });
  const repo = createMemoryRepo();
  const send = enabled ? { wa, repo, sendCode: CODE, testPhone, sendEnabled: true, sendDelayMs: 0 } : {};
  const app = createApp({ store, today: () => '2026-10-17', log: quiet, ...(limits ? { limits } : {}), ...send });
  return { app, repo, wa };
}

async function session(app, { auth = true, contacts = true } = {}) {
  const agent = request.agent(app);
  const up = await agent.post('/api/roster').attach('file', main, 'שבצק.xlsx');
  assert.equal(up.status, 201);
  if (auth) assert.equal((await agent.post('/api/auth').send({ code: CODE })).status, 204);
  if (auth && contacts) {
    const c = await agent.post('/api/contacts').attach('file', contactsXlsx, 'אנשי קשר.xlsx');
    assert.equal(c.status, 200);
  }
  return { agent, version: up.body.version };
}
const keyOf = (name) => roster.soldiers.find((s) => s.name === name).key;
const byId = new Map(roster.assignments.map((a) => [a.id, a]));
const overlapIds = new Set(roster.issues.filter((i) => i.code === 'OVERLAP').flatMap((i) => i.assignmentIds));
const expectedParams = (name) => {
  const s = roster.soldiers.find((x) => x.name === name);
  return buildWaMessage(s, s.assignmentIds.map((id) => byId.get(id)), roster.weekStart.date, { overlapIds }).params;
};

test('loadConfig: all vars present → enabled; any missing → disabled with names', () => {
  const env = {
    WA_TOKEN: 't', WA_PHONE_NUMBER_ID: '1', WA_WABA_ID: '2', WA_APP_SECRET: 's', WA_VERIFY_TOKEN: 'v',
    DATABASE_URL: 'postgres://x', PHONE_ENC_KEY: randomBytes(32).toString('base64'), SEND_CODE: 'c', WA_TEST_PHONE: '050-0000099',
  };
  const ok = loadConfig(env);
  assert.equal(ok.enabled, true);
  assert.deepEqual(ok.missing, []);
  assert.equal(ok.wa.templateName, 'duty_roster_week');
  assert.equal(ok.wa.templateLang, 'he');
  assert.equal(ok.testPhone, '972500000099');
  const off = loadConfig({ ...env, SEND_CODE: '', WA_TOKEN: undefined });
  assert.equal(off.enabled, false);
  assert.deepEqual(off.missing.sort(), ['SEND_CODE', 'WA_TOKEN']);
  assert.equal(loadConfig({ ...env, PHONE_ENC_KEY: 'short' }).enabled, false);
  assert.equal(loadConfig({ ...env, WA_TEST_PHONE: undefined }).enabled, true); // test phone optional
});

test('every send/contacts route is 401 before the access code', async () => {
  const { app, wa } = setup();
  const { agent, version } = await session(app, { auth: false });
  const key = keyOf('גדי דמה');
  const state = await agent.get(`/api/send/state?rosterVersion=${version}`);
  assert.equal(state.status, 200);
  assert.deepEqual(state.body, { enabled: true, authorized: false });
  assert.equal((await agent.post('/api/contacts').attach('file', contactsXlsx, 'c.xlsx')).status, 401);
  const send = await agent.post('/api/send').send({ personKeys: [key], rosterVersion: version, resend: false });
  assert.equal(send.status, 401);
  assert.equal(send.body.error, 'auth');
  assert.equal((await agent.post('/api/send/test').send({ personKey: key, rosterVersion: version })).status, 401);
  assert.equal(wa.calls.length, 0);
});

test('routes need a roster session', async () => {
  const { app } = setup();
  assert.equal((await request(app).post('/api/auth').send({ code: CODE })).status, 404);
  assert.equal((await request(app).get('/api/send/state')).status, 404);
});

test('wrong code → 401; right code → 204; 11th attempt → 429', async () => {
  const { app } = setup();
  const { agent, version } = await session(app, { auth: false });
  assert.equal((await agent.post('/api/auth').send({ code: 'לא נכון' })).status, 401);
  assert.equal((await agent.post('/api/auth').send({})).status, 401);
  assert.equal((await agent.post('/api/auth').send({ code: 12345 })).status, 401);
  const state = await agent.get(`/api/send/state?rosterVersion=${version}`);
  assert.equal(state.body.authorized, false);
  for (let i = 0; i < 6; i++) await agent.post('/api/auth').send({ code: 'x' });
  assert.equal((await agent.post('/api/auth').send({ code: CODE })).status, 204); // 10th
  assert.equal((await agent.post('/api/auth').send({ code: CODE })).status, 429); // 11th
});

test('state: contact status per soldier, never phone numbers', async () => {
  const { app } = setup();
  const { agent, version } = await session(app);
  const res = await agent.get(`/api/send/state?rosterVersion=${version}`);
  assert.equal(res.status, 200);
  assert.ok(!/9725\d{8}/.test(JSON.stringify(res.body)));
  assert.ok(!/050/.test(JSON.stringify(res.body)));
  assert.equal(res.body.enabled, true);
  assert.equal(res.body.authorized, true);
  assert.equal(res.body.template, 'APPROVED');
  assert.equal(res.body.weekStart, '2026-10-11');
  assert.equal(res.body.contacts.count, 3);
  const gadi = res.body.soldiers.find((s) => s.key === keyOf('גדי דמה'));
  assert.equal(gadi.contact, 'ok');
  assert.equal(gadi.sendable, true);
  assert.equal(gadi.warnings.length, 1);
  assert.equal(gadi.send, null);
  assert.equal(res.body.soldiers.find((s) => s.key === keyOf('דני דמה')).contact, 'none');
  assert.equal(res.body.soldiers.length, roster.soldiers.length);
  assert.equal((await agent.get('/api/send/state?rosterVersion=old')).status, 409);
});

test('contacts upload: non-xlsx refused; header-less file reported, list kept', async () => {
  const { app, repo } = setup();
  const { agent } = await session(app);
  assert.equal((await agent.post('/api/contacts').attach('file', Buffer.from('a,b'), 'c.csv')).status, 400);
  const bad = await buildContactsFixture([['גדי דמה', '050-0000005']], { headers: ['x', 'y'] });
  const res = await agent.post('/api/contacts').attach('file', bad, 'c.xlsx');
  assert.equal(res.status, 200);
  assert.equal(res.body.count, 0);
  assert.equal(res.body.errors[0].row, 0);
  assert.equal((await repo.listContacts()).length, 3);
  // names not in the current roster are still accepted
  const other = await buildContactsFixture([['מישהו אחר דמה', '050-0000006'], ['שגוי דמה', '123']]);
  const res2 = await agent.post('/api/contacts').attach('file', other, 'c.xlsx');
  assert.deepEqual([res2.body.count, res2.body.errors.length], [1, 1]);
  assert.ok(!/9725\d{8}/.test(JSON.stringify(res2.body)));
  assert.deepEqual((await repo.listContacts()).map((c) => c.name), ['מישהו אחר דמה']);
});

test('send happy path: normalized phone, Task 1 params, state shows accepted', async () => {
  const { app, wa } = setup();
  const { agent, version } = await session(app);
  const key = keyOf('גדי דמה');
  const res = await agent.post('/api/send').send({ personKeys: [key], rosterVersion: version, resend: false });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.results, [{ key, status: 'accepted', reason: null }]);
  assert.deepEqual(wa.calls, [{ to: '972500000001', params: expectedParams('גדי דמה') }]);
  const state = await agent.get(`/api/send/state?rosterVersion=${version}`);
  const gadi = state.body.soldiers.find((s) => s.key === key);
  assert.equal(gadi.send.status, 'accepted');
  assert.equal(gadi.send.changed, false);
  assert.ok(gadi.send.sentAt);
});

test('duplicate guard: second send skipped; resend: true sends again', async () => {
  const { app, wa } = setup();
  const { agent, version } = await session(app);
  const key = keyOf('גדי דמה');
  await agent.post('/api/send').send({ personKeys: [key], rosterVersion: version, resend: false });
  const again = await agent.post('/api/send').send({ personKeys: [key], rosterVersion: version, resend: false });
  assert.deepEqual(again.body.results, [{ key, status: 'skipped', reason: 'נשלח כבר' }]);
  assert.equal(wa.calls.length, 1);
  const resend = await agent.post('/api/send').send({ personKeys: [key], rosterVersion: version, resend: true });
  assert.equal(resend.body.results[0].status, 'accepted');
  assert.equal(wa.calls.length, 2);
});

test('two concurrent sends for the same soldier → client called once', async () => {
  const { app, wa } = setup();
  const { agent, version } = await session(app);
  const body = { personKeys: [keyOf('גדי דמה')], rosterVersion: version, resend: false };
  const [a, b] = await Promise.all([agent.post('/api/send').send(body), agent.post('/api/send').send(body)]);
  assert.equal(wa.calls.length, 1);
  assert.deepEqual([a.body.results[0].status, b.body.results[0].status].sort(), ['accepted', 'skipped']);
});

test('stale rosterVersion → 409, client not called; template PENDING → 409', async () => {
  const wa = fakeWa({ status: 'PENDING' });
  const { app } = setup({ wa });
  const { agent, version } = await session(app);
  const key = keyOf('גדי דמה');
  const stale = await agent.post('/api/send').send({ personKeys: [key], rosterVersion: 'old', resend: false });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.error, 'stale');
  const pending = await agent.post('/api/send').send({ personKeys: [key], rosterVersion: version, resend: false });
  assert.equal(pending.status, 409);
  assert.equal(pending.body.error, 'template');
  assert.equal((await agent.post('/api/send/test').send({ personKey: key, rosterVersion: version })).status, 409);
  assert.equal(wa.calls.length, 0);
});

test('bad bodies → 400', async () => {
  const { app, wa } = setup();
  const { agent, version } = await session(app);
  for (const personKeys of [[], 'x', Array(21).fill(keyOf('גדי דמה')), ['לא קיים דמה']]) {
    assert.equal((await agent.post('/api/send').send({ personKeys, rosterVersion: version })).status, 400);
  }
  assert.equal(wa.calls.length, 0);
});

test('blocked soldier (unresolved shift) and no-number soldier → skipped; overlap soldier → sent', async () => {
  const { app, wa } = setup();
  const { agent, version } = await session(app);
  const keys = [keyOf('עומר דמה'), keyOf('דני דמה'), keyOf('גדי דמה')];
  const res = await agent.post('/api/send').send({ personKeys: keys, rosterVersion: version, resend: false });
  const [omer, dani, gadi] = res.body.results;
  assert.equal(omer.status, 'skipped');
  assert.match(omer.reason, /ללא תאריך ושעה/);
  assert.equal(dani.status, 'skipped');
  assert.match(dani.reason, /אין מספר/);
  assert.equal(gadi.status, 'accepted');
  assert.deepEqual(wa.calls.map((c) => c.to), ['972500000001']);
});

test('failed send is recorded as failed with the Meta reason', async () => {
  const { app, repo } = setup({ wa: fakeWa({ fail: true }) });
  const { agent, version } = await session(app);
  const key = keyOf('גדי דמה');
  const res = await agent.post('/api/send').send({ personKeys: [key], rosterVersion: version, resend: false });
  assert.deepEqual(res.body.results, [{ key, status: 'failed', reason: 'שגיאת Meta (קוד 1)' }]);
  const rec = (await repo.listSends('2026-10-11')).get(key);
  assert.equal(rec.status, 'failed');
});

test('changed since sent: stored hash differs from the current message', async () => {
  const { app, repo } = setup();
  const { agent, version } = await session(app);
  const key = keyOf('גדי דמה');
  await repo.reserveSend({ weekStart: '2026-10-11', soldierKey: key, soldierName: 'גדי דמה', paramsHash: 'old-hash', resend: false });
  await repo.completeSend({ weekStart: '2026-10-11', soldierKey: key, wamid: 'wamid.x', status: 'accepted' });
  const state = await agent.get(`/api/send/state?rosterVersion=${version}`);
  assert.equal(state.body.soldiers.find((s) => s.key === key).send.changed, true);
});

test('test send → client called with testPhone; no send records', async () => {
  const { app, wa, repo } = setup();
  const { agent, version } = await session(app);
  const key = keyOf('דני דמה'); // no contact needed for a test send
  const res = await agent.post('/api/send/test').send({ personKey: key, rosterVersion: version });
  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'accepted');
  assert.deepEqual(wa.calls, [{ to: TEST_PHONE, params: expectedParams('דני דמה') }]);
  assert.equal((await repo.listSends('2026-10-11')).size, 0);
  assert.equal((await agent.post('/api/send/test').send({ personKey: 'לא קיים', rosterVersion: version })).status, 400);
});

test('test send without WA_TEST_PHONE → 400', async () => {
  const { app, wa } = setup({ testPhone: null });
  const { agent, version } = await session(app);
  assert.equal((await agent.post('/api/send/test').send({ personKey: keyOf('גדי דמה'), rosterVersion: version })).status, 400);
  assert.equal(wa.calls.length, 0);
});

test('config disabled: state is { enabled: false }, other routes 503, roster/search still work', async () => {
  const { app } = setup({ enabled: false });
  const { agent, version } = await session(app, { auth: false });
  const state = await agent.get(`/api/send/state?rosterVersion=${version}`);
  assert.deepEqual(state.body, { enabled: false });
  assert.equal((await agent.post('/api/auth').send({ code: CODE })).status, 503);
  assert.equal((await agent.post('/api/contacts').attach('file', contactsXlsx, 'c.xlsx')).status, 503);
  assert.equal((await agent.post('/api/send').send({ personKeys: ['x'], rosterVersion: version })).status, 503);
  assert.equal((await agent.post('/api/send/test').send({ personKey: 'x', rosterVersion: version })).status, 503);
  assert.equal((await agent.get('/api/roster')).status, 200);
  const search = await agent.post('/api/search').send({ date: '2026-10-12', hour: 9, postId: 'all', rosterVersion: version });
  assert.equal(search.status, 200);
});
