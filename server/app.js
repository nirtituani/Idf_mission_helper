import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import helmet from 'helmet';
import multer from 'multer';
import { rateLimit } from 'express-rate-limit';
import { parseRoster } from '../src/core/index.js';
import { searchOnDuty, SearchError } from '../src/core/search.js';
import { isIsoDate, todayIso } from '../src/core/dates.js';
import { rosterMessageBuilder } from '../src/core/wa-message.js';
import { registerSendRoutes } from './send-routes.js';
import { webhookRouter, disabledWebhookRouter } from './webhook.js';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const COOKIE = 'roster_sid';
const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

const DEFAULT_LIMITS = { uploadsPer10Min: 20, apiPerMinute: 300, authPer15Min: 10 };

// wa/repo/sendCode/testPhone: WhatsApp sending (see send-routes.js); webhook: { appSecret, verifyToken }; sendEnabled defaults to "all given".
export function createApp({
  store, secureCookies = false, today = () => todayIso(), log = console, limits = DEFAULT_LIMITS,
  wa = null, repo = null, webhook = null, sendCode = null, testPhone = null, sendEnabled = Boolean(wa && repo && sendCode), sendDelayMs = 150,
}) {
  const app = express();
  app.disable('x-powered-by');
  // Private tool: keep it out of search engines.
  app.use((req, res, next) => {
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    next();
  });
  app.get('/robots.txt', (req, res) => res.type('text/plain').send('User-agent: *\nAllow: /privacy\nAllow: /privacy.html\nDisallow: /\n'));
  // upgrade-insecure-requests only over HTTPS: on http://localhost Safari would upgrade the CSS/JS
  // requests to https://localhost and load a blank, unstyled page.
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: { 'script-src': ["'self'"], 'img-src': ["'self'", 'data:'], 'upgrade-insecure-requests': secureCookies ? [] : null },
      },
    }),
  );
  // Meta's status webhook: before express.json (it needs the raw body for the signature check).
  app.use(webhook?.appSecret && webhook?.verifyToken && repo
    ? webhookRouter({ repo, appSecret: webhook.appSecret, verifyToken: webhook.verifyToken, log })
    : disabledWebhookRouter());
  app.use(express.json({ limit: '10kb' }));
  app.use(express.static(PUBLIC_DIR, { index: 'index.html' }));
  // Public privacy policy (its URL is entered in the Meta app settings).
  app.get('/privacy', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'privacy.html')));
  // The browser shares these pure core modules (no Node APIs) — an explicit allowlist, not the folder.
  for (const file of ['dates.js', 'filters.js', 'week.js', 'shifts.js', 'grid.js']) {
    app.get(`/core/${file}`, (req, res) => res.type('text/javascript').sendFile(path.join(PUBLIC_DIR, '..', 'src', 'core', file)));
  }

  // Per-IP rate limits (behind a proxy, `trust proxy` is set in index.js so req.ip is the client).
  const tooMany = (message) => ({ error: 'rate', message });
  app.use('/api', rateLimit({ windowMs: 60 * 1000, limit: limits.apiPerMinute, standardHeaders: 'draft-7', legacyHeaders: false, message: tooMany('יותר מדי בקשות. נסו שוב בעוד דקה.') }));
  const uploadLimiter = rateLimit({ windowMs: 10 * 60 * 1000, limit: limits.uploadsPer10Min, standardHeaders: 'draft-7', legacyHeaders: false, message: tooMany('יותר מדי העלאות. נסו שוב בעוד כמה דקות.') });

  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_UPLOAD_BYTES, files: 1, fields: 5 } });

  const readToken = (req) => {
    const header = req.headers.cookie || '';
    for (const part of header.split(';')) {
      const [k, ...v] = part.trim().split('=');
      if (k === COOKIE) return v.join('=');
    }
    return null;
  };
  const setCookie = (res, token) =>
    res.cookie(COOKIE, token, { httpOnly: true, sameSite: 'strict', secure: secureCookies, path: '/api' });

  const requireRoster = (req, res, next) => {
    const session = store.get(readToken(req));
    if (!session?.data) return res.status(404).json({ error: 'no-roster', message: 'לא הועלה שיבוץ בהפעלה זו, או שתוקף ההפעלה פג.' });
    req.session = session;
    next();
  };

  app.get('/api/health', (req, res) => res.json({ ok: true }));

  // Multipart "file" → { fileName, buffer } of an .xlsx, or null after answering 400.
  const readXlsx = (req, res) =>
    new Promise((resolve) => {
      upload.single('file')(req, res, (err) => {
        if (err) {
          const message = err.code === 'LIMIT_FILE_SIZE' ? 'הקובץ גדול מ־5MB.' : 'העלאת הקובץ נכשלה.';
          res.status(400).json({ error: 'upload', message });
          return resolve(null);
        }
        if (!req.file) {
          res.status(400).json({ error: 'upload', message: 'לא נבחר קובץ.' });
          return resolve(null);
        }
        const fileName = decodeFileName(req.file.originalname);
        const buffer = req.file.buffer;
        if (!/\.xlsx$/i.test(fileName) || buffer.length < 4 || buffer[0] !== 0x50 || buffer[1] !== 0x4b) {
          res.status(400).json({ error: 'format', message: 'יש להעלות קובץ Excel בפורמט ‎.xlsx‎.' });
          return resolve(null);
        }
        resolve({ fileName, buffer });
      });
    });

  // true when it answered 409 (the browser's roster is not the session's current one).
  const checkVersion = (req, res, version) => {
    if (version === req.session.data.roster.version) return false;
    res.status(409).json({ error: 'stale', message: 'השיבוץ הוחלף מאז שהמסך נטען. יש לרענן את הנתונים.' });
    return true;
  };

  app.post('/api/roster', uploadLimiter, async (req, res, next) => {
    try {
      const file = await readXlsx(req, res);
      if (!file) return;
      const { fileName, buffer: buf } = file;
      let roster;
      try {
        roster = await parseRoster(buf, { fileName, today: today() });
      } catch (e) {
        log.warn('roster parse failed:', e.message);
        return res.status(422).json({ error: 'parse', message: 'לא ניתן לקרוא את הקובץ כגיליון Excel תקין. השיבוץ הקודם (אם היה) לא השתנה.' });
      }
      let token = readToken(req);
      let session = store.get(token);
      if (!session) {
        token = store.create();
        if (!token) return res.status(503).json({ error: 'busy', message: 'השרת עמוס כרגע. נסו שוב בעוד כמה דקות.' });
        session = store.get(token);
      }
      // Replace everything from any previous upload — no stale posts or assignments survive.
      session.data = { fileName, buffer: buf, roster };
      setCookie(res, token);
      res.status(201).json(roster);
    } catch (e) {
      next(e);
    }
  });

  app.get('/api/roster', requireRoster, (req, res) => res.json(req.session.data.roster));

  app.put('/api/roster/week-start', requireRoster, async (req, res, next) => {
    const { date } = req.body || {};
    if (date !== null && !isIsoDate(date)) return res.status(400).json({ error: 'date', message: 'תאריך לא תקין.' });
    try {
      const data = req.session.data;
      data.roster = await parseRoster(data.buffer, { fileName: data.fileName, today: today(), weekStartOverride: date });
      res.json(data.roster);
    } catch (e) {
      next(e);
    }
  });

  app.post('/api/search', requireRoster, (req, res) => {
    const { date, hour, postId, rosterVersion } = req.body || {};
    const { roster } = req.session.data;
    if (checkVersion(req, res, rosterVersion)) return;
    try {
      res.json(searchOnDuty(roster, roster.options, { date, hour, postId }));
    } catch (e) {
      if (e instanceof SearchError) return res.status(400).json({ error: 'query', message: e.message });
      throw e;
    }
  });

  // ---- Messages: preview of the exact WhatsApp template message for the roster's selected week ----
  app.post('/api/messages/preview', requireRoster, (req, res) => {
    const { personKeys, rosterVersion } = req.body || {};
    const { roster } = req.session.data;
    if (checkVersion(req, res, rosterVersion)) return;
    if (!Array.isArray(personKeys) || personKeys.length === 0 || personKeys.length > 1000) {
      return res.status(400).json({ error: 'query', message: 'לא נבחרו חיילים.' });
    }
    const soldiers = new Map(roster.soldiers.map((s) => [s.key, s]));
    const build = rosterMessageBuilder(roster);
    const messages = [];
    for (const key of personKeys) {
      const soldier = soldiers.get(key);
      if (!soldier) return res.status(400).json({ error: 'query', message: 'חייל שנבחר אינו קיים בשיבוץ הנוכחי.' });
      const { text, problems, warnings, sendable } = build(soldier);
      messages.push({ key, name: soldier.name, text, problems, warnings, sendable });
    }
    res.json({ messages });
  });

  registerSendRoutes(app, {
    enabled: sendEnabled, wa, repo, sendCode, testPhone, sendDelayMs, log,
    authLimit: limits.authPer15Min ?? DEFAULT_LIMITS.authPer15Min,
    helpers: { requireRoster, checkVersion, readXlsx, uploadLimiter },
  });

  app.delete('/api/session', (req, res) => {
    store.destroy(readToken(req));
    res.clearCookie(COOKIE, { path: '/api' });
    res.status(204).end();
  });

  app.use('/api', (req, res) => res.status(404).json({ error: 'not-found' }));

  // Never echo request bodies or roster contents into logs.
  app.use((err, req, res, next) => {
    log.error('request failed:', err.message);
    res.status(500).json({ error: 'server', message: 'שגיאת שרת.' });
  });

  return app;
}

// Browsers send UTF-8 filenames; multer/busboy decode them as latin1.
function decodeFileName(name) {
  const utf8 = Buffer.from(name, 'latin1').toString('utf8');
  return utf8.includes('�') ? name : utf8;
}
