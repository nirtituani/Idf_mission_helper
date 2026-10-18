import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createCipher } from '../server/crypto.js';
import { createMemoryRepo, createPgRepo } from '../server/repo.js';

const key = () => randomBytes(32).toString('base64');

describe('cipher', () => {
  test('round-trips and uses a random IV', () => {
    const c = createCipher(key());
    const a = c.encrypt('972500000001');
    assert.equal(c.decrypt(a), '972500000001');
    assert.notEqual(a, c.encrypt('972500000001'));
  });
  test('wrong key fails to decrypt', () => {
    const enc = createCipher(key()).encrypt('972500000001');
    assert.throws(() => createCipher(key()).decrypt(enc));
  });
  test('rejects keys that are not 32 bytes', () => {
    assert.throws(() => createCipher(randomBytes(16).toString('base64')));
  });
});

const W = '2026-10-18';
const base = { weekStart: W, soldierKey: 'k1', soldierName: 'חייל דמה', paramsHash: 'h1' };

function repoContract(makeRepo) {
  test('replaceContacts replaces and counts', async () => {
    const r = await makeRepo();
    await r.replaceContacts([{ name: 'א דמה', phone: '972500000001' }, { name: 'ב דמה', phone: '972500000002' }]);
    await r.replaceContacts([{ name: 'ג דמה', phone: '972500000003' }]);
    assert.deepEqual(await r.listContacts(), [{ name: 'ג דמה', phone: '972500000003' }]);
    const info = await r.contactsInfo();
    assert.equal(info.count, 1);
    assert.ok(info.updatedAt);
  });
  test('contactsInfo on empty repo', async () => {
    const info = await (await makeRepo()).contactsInfo();
    assert.equal(info.count, 0);
  });
  test('reserveSend duplicate guard', async () => {
    const r = await makeRepo();
    assert.deepEqual(await r.reserveSend({ ...base, resend: false }), { ok: true });
    const again = await r.reserveSend({ ...base, resend: false });
    assert.equal(again.ok, false);
    assert.equal(again.existing.status, 'sending');
    assert.equal((await r.reserveSend({ ...base, resend: true })).ok, false);
    await r.completeSend({ ...base, wamid: 'w1', status: 'accepted' });
    assert.equal((await r.reserveSend({ ...base, resend: false })).ok, false);
    assert.equal((await r.reserveSend({ ...base, paramsHash: 'h2', resend: true })).ok, true);
    const m = await r.listSends(W);
    assert.equal(m.get('k1').status, 'sending');
    assert.equal(m.get('k1').paramsHash, 'h2');
  });
  test('concurrent reserves: only one wins', async () => {
    const r = await makeRepo();
    const res = await Promise.all([1, 2, 3].map(() => r.reserveSend({ ...base, resend: false })));
    assert.equal(res.filter(x => x.ok).length, 1);
  });
  test('listSends returns week entries only, weekStart as string', async () => {
    const r = await makeRepo();
    await r.reserveSend({ ...base, resend: false });
    await r.reserveSend({ ...base, weekStart: '2026-10-25', resend: false });
    await r.completeSend({ ...base, wamid: 'w1', status: 'failed', error: 'boom' });
    const m = await r.listSends(W);
    assert.equal(m.size, 1);
    const e = m.get('k1');
    assert.equal(e.status, 'failed');
    assert.equal(e.error, 'boom');
    assert.equal(e.paramsHash, 'h1');
    assert.ok(e.sentAt && e.statusAt);
  });
  test('applyStatus ranking', async () => {
    const r = await makeRepo();
    await r.reserveSend({ ...base, resend: false });
    await r.completeSend({ ...base, wamid: 'w1', status: 'accepted' });
    const st = async () => (await r.listSends(W)).get('k1').status;
    await r.applyStatus({ wamid: 'w1', status: 'read', at: new Date() });
    await r.applyStatus({ wamid: 'w1', status: 'delivered', at: new Date() });
    assert.equal(await st(), 'read');
    await r.applyStatus({ wamid: 'w1', status: 'failed', error: 'x', at: new Date() });
    assert.equal(await st(), 'read');
  });
  test('applyStatus failed after sent; no downgrade; unknown wamid', async () => {
    const r = await makeRepo();
    await r.reserveSend({ ...base, resend: false });
    await r.completeSend({ ...base, wamid: 'w1', status: 'accepted' });
    const st = async () => (await r.listSends(W)).get('k1');
    await r.applyStatus({ wamid: 'w1', status: 'delivered', at: new Date() });
    await r.applyStatus({ wamid: 'w1', status: 'sent', at: new Date() });
    assert.equal((await st()).status, 'delivered');
    await r.applyStatus({ wamid: 'w1', status: 'failed', error: 'e', at: new Date() });
    const e = await st();
    assert.equal(e.status, 'failed');
    assert.equal(e.error, 'e');
    await r.applyStatus({ wamid: 'nope', status: 'read', at: new Date() });
  });
}

describe('memory repo', () => repoContract(async () => createMemoryRepo()));

const url = process.env.TEST_DATABASE_URL;
describe('postgres repo', { skip: !url && 'TEST_DATABASE_URL not set' }, () => {
  const repos = [];
  after(() => Promise.all(repos.map(r => r.close())));
  repoContract(async () => {
    const repo = createPgRepo({ databaseUrl: url, cipher: createCipher(key()) });
    repos.push(repo);
    await repo._reset();
    return repo;
  });
});
