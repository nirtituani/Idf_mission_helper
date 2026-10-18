// Access code, contacts upload and WhatsApp send routes. Messages are always built on the server
// from the parsed roster; phone numbers never leave the server and are never logged.
import { createHash, timingSafeEqual } from 'node:crypto';
import { rateLimit } from 'express-rate-limit';
import { rosterMessageBuilder } from '../src/core/wa-message.js';
import { matchContacts, parseContactsWorkbook } from '../src/core/contacts.js';
import { normalizePhone } from '../src/core/phones.js';

const MAX_SEND = 20;
const digest = (s) => createHash('sha256').update(String(s), 'utf8').digest();

const CONTACT_REASON = {
  none: 'אין מספר טלפון לחייל זה ברשימת אנשי הקשר.',
  ambiguous: 'יותר מאיש קשר אחד מתאים לשם — לא נשלח.',
};
const TEMPLATE_MESSAGE = 'תבנית ההודעה עדיין לא אושרה על ידי Meta — לא ניתן לשלוח כרגע.';

function reservedReason(existing) {
  if (existing?.status === 'sending') return 'שליחה לחייל זה מתבצעת כרגע';
  if (existing?.status === 'failed') return 'שליחה קודמת נכשלה — יש לבחור "שליחה שוב"';
  return 'נשלח כבר';
}

// helpers from app.js: requireRoster, checkVersion(req, res, version) → true if it answered 409,
// readXlsx(req, res) → { fileName, buffer } or null (response already sent), uploadLimiter.
export function registerSendRoutes(app, { enabled, wa, repo, sendCode, testPhone, sendDelayMs = 150, authLimit = 10, log, helpers }) {
  const { requireRoster, checkVersion, readXlsx, uploadLimiter } = helpers;
  const wait = (ms) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());

  const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: authLimit,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { error: 'rate', message: 'יותר מדי ניסיונות. נסו שוב בעוד רבע שעה.' },
  });

  const requireEnabled = (req, res, next) =>
    enabled ? next() : res.status(503).json({ error: 'disabled', message: 'שליחה ב־WhatsApp אינה מוגדרת בשרת זה.' });
  const requireAuth = (req, res, next) =>
    req.session.authorized === true ? next() : res.status(401).json({ error: 'auth', message: 'יש להזין את קוד הגישה.' });
  const gate = [requireRoster, requireEnabled, requireAuth];

  const templateApproved = async (res) => {
    if ((await wa.templateStatus()) === 'APPROVED') return true;
    res.status(409).json({ error: 'template', message: TEMPLATE_MESSAGE });
    return false;
  };

  app.post('/api/auth', authLimiter, requireRoster, requireEnabled, (req, res) => {
    const { code } = req.body || {};
    if (sendCode && typeof code === 'string' && code.length > 0 && timingSafeEqual(digest(code), digest(sendCode))) {
      req.session.authorized = true;
      return res.status(204).end();
    }
    res.status(401).json({ error: 'auth', message: 'קוד הגישה שגוי.' });
  });

  app.get('/api/send/state', requireRoster, async (req, res, next) => {
    if (!enabled) return res.json({ enabled: false });
    if (req.session.authorized !== true) return res.json({ enabled: true, authorized: false });
    const { roster } = req.session.data;
    if (checkVersion(req, res, req.query.rosterVersion)) return;
    try {
      const weekStart = roster.weekStart?.date ?? null;
      const [template, contacts, info, sends] = await Promise.all([
        wa.templateStatus(),
        repo.listContacts(),
        repo.contactsInfo(),
        weekStart ? repo.listSends(weekStart) : new Map(),
      ]);
      const matches = matchContacts(roster.soldiers, contacts);
      const build = rosterMessageBuilder(roster);
      const soldiers = roster.soldiers.map((s) => {
        const msg = build(s);
        const rec = sends.get(s.key);
        return {
          key: s.key,
          contact: matches.get(s.key).status, // status only — never the phone number
          sendable: msg.sendable,
          problems: msg.problems,
          warnings: msg.warnings,
          send: rec ? { status: rec.status, error: rec.error, sentAt: rec.sentAt, changed: rec.paramsHash !== msg.hash } : null,
        };
      });
      res.json({ enabled: true, authorized: true, template, weekStart, contacts: { count: info.count, updatedAt: info.updatedAt }, soldiers });
    } catch (e) {
      next(e);
    }
  });

  app.post('/api/contacts', uploadLimiter, ...gate, async (req, res, next) => {
    const file = await readXlsx(req, res);
    if (!file) return;
    let parsed;
    try {
      parsed = await parseContactsWorkbook(file.buffer);
    } catch (e) {
      log.warn('contacts parse failed:', e.message);
      return res.status(422).json({ error: 'parse', message: 'לא ניתן לקרוא את הקובץ כגיליון Excel תקין. רשימת אנשי הקשר לא השתנתה.' });
    }
    try {
      // Replace the stored list only when the file has usable rows (a wrong file must not wipe it).
      if (parsed.contacts.length > 0) await repo.replaceContacts(parsed.contacts);
      res.json({ count: parsed.contacts.length, errors: parsed.errors });
    } catch (e) {
      next(e);
    }
  });

  app.post('/api/send', ...gate, async (req, res, next) => {
    const { personKeys, rosterVersion, resend } = req.body || {};
    const { roster } = req.session.data;
    if (!Array.isArray(personKeys) || personKeys.length === 0 || personKeys.length > MAX_SEND || !personKeys.every((k) => typeof k === 'string')) {
      return res.status(400).json({ error: 'query', message: `יש לבחור בין 1 ל־${MAX_SEND} חיילים.` });
    }
    if (checkVersion(req, res, rosterVersion)) return;
    const soldiers = new Map(roster.soldiers.map((s) => [s.key, s]));
    if (!personKeys.every((k) => soldiers.has(k))) {
      return res.status(400).json({ error: 'query', message: 'חייל שנבחר אינו קיים בשיבוץ הנוכחי.' });
    }
    try {
      if (!(await templateApproved(res))) return;
      const weekStart = roster.weekStart?.date ?? null;
      const matches = matchContacts(roster.soldiers, await repo.listContacts());
      const build = rosterMessageBuilder(roster);
      const results = [];
      let sent = 0;
      for (const key of new Set(personKeys)) {
        let accepted = false; // true once WhatsApp took the message
        try {
          const soldier = soldiers.get(key);
          const msg = build(soldier);
          if (!msg.sendable) {
            results.push({ key, status: 'skipped', reason: msg.problems[0] });
            continue;
          }
          const contact = matches.get(key);
          if (contact.status !== 'ok') {
            results.push({ key, status: 'skipped', reason: CONTACT_REASON[contact.status] });
            continue;
          }
          const reserved = await repo.reserveSend({ weekStart, soldierKey: key, soldierName: soldier.name, paramsHash: msg.hash, resend: resend === true });
          if (!reserved.ok) {
            results.push({ key, status: 'skipped', reason: reservedReason(reserved.existing) });
            continue;
          }
          if (sent++ > 0) await wait(sendDelayMs);
          const r = await wa.sendTemplate(contact.phone, msg.params);
          accepted = r.ok;
          await repo.completeSend({ weekStart, soldierKey: key, wamid: r.ok ? r.wamid : null, status: r.ok ? 'accepted' : 'failed', error: r.ok ? null : r.error });
          results.push({ key, status: r.ok ? 'accepted' : 'failed', reason: r.ok ? null : r.error });
        } catch (e) {
          // A DB/repo error for one soldier must not abort the batch. If it happened after the send,
          // the row stays "sending" (blocks duplicates; a resend may take it over after 5 minutes).
          log.error('send failed for one soldier:', e.message);
          results.push(accepted
            ? { key, status: 'accepted', reason: 'ההודעה נשלחה, אך שמירת הרישום נכשלה — אין לשלוח שוב' }
            : { key, status: 'failed', reason: 'שגיאת שרת — נסו שוב' });
        }
      }
      res.json({ results });
    } catch (e) {
      next(e);
    }
  });

  app.post('/api/send/test', ...gate, async (req, res, next) => {
    const { personKey, rosterVersion } = req.body || {};
    const { roster } = req.session.data;
    const to = normalizePhone(testPhone);
    if (!to) return res.status(400).json({ error: 'test-phone', message: 'לא הוגדר מספר לבדיקה בשרת (WA_TEST_PHONE).' });
    if (checkVersion(req, res, rosterVersion)) return;
    const soldier = roster.soldiers.find((s) => s.key === personKey);
    if (!soldier) return res.status(400).json({ error: 'query', message: 'חייל שנבחר אינו קיים בשיבוץ הנוכחי.' });
    try {
      if (!(await templateApproved(res))) return;
      const msg = rosterMessageBuilder(roster)(soldier);
      if (!msg.sendable) return res.json({ key: personKey, status: 'skipped', reason: msg.problems[0] });
      // Test sends bypass the duplicate guard and write no send record.
      const r = await wa.sendTemplate(to, msg.params);
      res.json({ key: personKey, status: r.ok ? 'accepted' : 'failed', reason: r.ok ? null : r.error });
    } catch (e) {
      next(e);
    }
  });
}
