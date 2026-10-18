// Meta → us: webhook handshake and delivery statuses for messages we sent. Needs the RAW body
// (mounted with express.raw before express.json) so the signature is checked over the exact bytes.
// Never logs bodies, phone numbers or message text.
import { createHmac, timingSafeEqual } from 'node:crypto';
import express from 'express';
import { describeError } from './whatsapp.js';

export const WEBHOOK_PATH = '/webhooks/whatsapp';

function validSignature(appSecret, header, raw) {
  if (typeof header !== 'string' || !Buffer.isBuffer(raw)) return false;
  const expected = Buffer.from('sha256=' + createHmac('sha256', appSecret).update(raw).digest('hex'), 'utf8');
  const given = Buffer.from(header, 'utf8');
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export function webhookRouter({ repo, appSecret, verifyToken, log = console }) {
  const router = express.Router();
  router.get(WEBHOOK_PATH, (req, res) => {
    const { 'hub.mode': mode, 'hub.verify_token': token, 'hub.challenge': challenge } = req.query;
    if (mode === 'subscribe' && typeof token === 'string' && token === verifyToken && challenge !== undefined) {
      return res.status(200).type('text/plain').send(String(challenge));
    }
    res.status(403).end();
  });

  router.post(WEBHOOK_PATH, express.raw({ type: 'application/json', limit: '1mb' }), async (req, res) => {
    if (!validSignature(appSecret, req.get('X-Hub-Signature-256'), req.body)) return res.status(401).end();
    let data;
    try {
      data = JSON.parse(req.body.toString('utf8'));
    } catch {
      log.warn('webhook: ignoring unparseable payload');
      return res.status(200).end();
    }
    const entries = Array.isArray(data?.entry) ? data.entry : [];
    let failed = false;
    for (const entry of entries) {
      for (const change of Array.isArray(entry?.changes) ? entry.changes : []) {
        const statuses = change?.value?.statuses;
        if (!Array.isArray(statuses)) continue; // incoming user messages are ignored
        for (const s of statuses) {
          try {
            await repo.applyStatus({
              wamid: s?.id,
              status: s?.status,
              error: s?.errors?.[0] ? describeError(s.errors[0].code) : null,
              at: Number.isFinite(Number(s?.timestamp)) ? new Date(Number(s.timestamp) * 1000) : new Date(),
            });
          } catch (e) {
            failed = true;
            log.error('webhook: status update failed:', e.message);
          }
        }
      }
    }
    // 500 makes Meta retry; applyStatus is idempotent.
    res.status(failed ? 500 : 200).end();
  });

  return router;
}

// Same path, but answers 503 when the webhook is not configured.
export function disabledWebhookRouter() {
  const router = express.Router();
  router.all(WEBHOOK_PATH, (req, res) => res.status(503).end());
  return router;
}
