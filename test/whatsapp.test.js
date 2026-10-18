import test from 'node:test';
import assert from 'node:assert/strict';
import { createWhatsAppClient, describeError } from '../server/whatsapp.js';

const resp = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const okBody = { messaging_product: 'whatsapp', contacts: [{}], messages: [{ id: 'wamid.TEST1' }] };
const errBody = (code) => ({ error: { message: 'x', type: 'OAuthException', code } });

function setup(handlers, extra = {}) {
  const calls = [];
  const sleeps = [];
  const queue = [...handlers];
  const fetch = async (url, opts) => {
    calls.push({ url, opts });
    const h = queue.shift();
    if (h instanceof Error) throw h;
    return h;
  };
  const client = createWhatsAppClient({
    token: 'tok-dummy', phoneNumberId: '111', wabaId: '222',
    templateName: 'duty_roster_week', templateLang: 'he',
    fetch, sleep: async (ms) => { sleeps.push(ms); }, ...extra,
  });
  return { client, calls, sleeps };
}
const params = Array.from({ length: 10 }, (_, i) => `p${i}`);

test('sendTemplate sends exact request and returns wamid', async () => {
  const { client, calls } = setup([resp(200, okBody)]);
  const r = await client.sendTemplate('972500000001', params);
  assert.deepEqual(r, { ok: true, wamid: 'wamid.TEST1' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://graph.facebook.com/v25.0/111/messages');
  assert.equal(calls[0].opts.method, 'POST');
  assert.equal(calls[0].opts.headers.Authorization, 'Bearer tok-dummy');
  assert.equal(calls[0].opts.headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(calls[0].opts.body), {
    messaging_product: 'whatsapp', to: '972500000001', type: 'template',
    template: {
      name: 'duty_roster_week', language: { code: 'he' },
      components: [{ type: 'body', parameters: params.map((text) => ({ type: 'text', text })) }],
    },
  });
});

test('131026 fails with Hebrew text and no retry', async () => {
  const { client, calls, sleeps } = setup([resp(400, errBody(131026))]);
  const r = await client.sendTemplate('972500000001', params);
  assert.deepEqual(r, { ok: false, error: 'המספר אינו זמין ב־WhatsApp' });
  assert.equal(calls.length, 1);
  assert.equal(sleeps.length, 0);
});

test('130429 then success retries once after 2s', async () => {
  const { client, calls, sleeps } = setup([resp(400, errBody(130429)), resp(200, okBody)]);
  const r = await client.sendTemplate('972500000001', params);
  assert.equal(r.ok, true);
  assert.equal(calls.length, 2);
  assert.deepEqual(sleeps, [2000]);
});

test('network error then success retries once; two network errors fail without throwing', async () => {
  let s = setup([new Error('boom'), resp(200, okBody)]);
  assert.equal((await s.client.sendTemplate('1', params)).ok, true);
  s = setup([new Error('boom'), new Error('boom')]);
  const r = await s.client.sendTemplate('1', params);
  assert.equal(r.ok, false);
  assert.equal(typeof r.error, 'string');
  assert.equal(s.calls.length, 2);
});

test('500 twice fails after one retry', async () => {
  const { client, calls } = setup([resp(500, {}), resp(500, {})]);
  const r = await client.sendTemplate('972500000001', params);
  assert.equal(r.ok, false);
  assert.equal(calls.length, 2);
});

test('request uses a timeout signal', async () => {
  const { client, calls } = setup([resp(200, okBody)]);
  await client.sendTemplate('1', params);
  assert.ok(calls[0].opts.signal);
});

test('templateStatus requests list, caches 5 minutes, picks matching language', async () => {
  let t = 1000;
  const body = { data: [
    { name: 'duty_roster_week', status: 'REJECTED', language: 'en' },
    { name: 'duty_roster_week', status: 'APPROVED', language: 'he' },
  ] };
  const { client, calls } = setup([resp(200, body), resp(200, { data: [] })], { now: () => t });
  assert.equal(await client.templateStatus(), 'APPROVED');
  assert.equal(calls[0].url, 'https://graph.facebook.com/v25.0/222/message_templates?name=duty_roster_week&fields=name,status,language');
  assert.equal(calls[0].opts.headers.Authorization, 'Bearer tok-dummy');
  t += 4 * 60 * 1000;
  assert.equal(await client.templateStatus(), 'APPROVED');
  assert.equal(calls.length, 1);
  t += 2 * 60 * 1000;
  assert.equal(await client.templateStatus(), 'MISSING');
  assert.equal(calls.length, 2);
});

test('templateStatus language mismatch is MISSING', async () => {
  const { client } = setup([resp(200, { data: [{ name: 'duty_roster_week', status: 'APPROVED', language: 'en' }] })]);
  assert.equal(await client.templateStatus(), 'MISSING');
});

test('templateStatus ERROR is not cached', async () => {
  const { client, calls } = setup([resp(500, {}), resp(200, { data: [{ status: 'PENDING', language: 'he' }] })]);
  assert.equal(await client.templateStatus(), 'ERROR');
  assert.equal(await client.templateStatus(), 'PENDING');
  assert.equal(calls.length, 2);
});

test('templateStatus network failure is ERROR', async () => {
  const { client } = setup([new Error('boom')]);
  assert.equal(await client.templateStatus(), 'ERROR');
});

test('describeError maps codes to Hebrew', () => {
  assert.equal(describeError(131026), 'המספר אינו זמין ב־WhatsApp');
  assert.equal(describeError(130429), 'חריגה ממגבלת שליחה של Meta');
  assert.equal(describeError(131048), 'חריגה ממגבלת שליחה של Meta');
  assert.equal(describeError(132000), 'בעיה בתבנית ההודעה');
  assert.equal(describeError(132015), 'בעיה בתבנית ההודעה');
  assert.equal(describeError(190), 'אסימון הגישה של Meta אינו תקף');
  assert.equal(describeError(999), 'שגיאת Meta (קוד 999)');
  const { client } = setup([]);
  assert.equal(client.describeError(190), 'אסימון הגישה של Meta אינו תקף');
});
