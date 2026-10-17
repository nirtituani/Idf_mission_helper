import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import helmet from 'helmet';
import multer from 'multer';
import { parseRoster } from '../src/core/index.js';
import { searchOnDuty, SearchError } from '../src/core/search.js';
import { isIsoDate, todayIso } from '../src/core/dates.js';
import { DEFAULT_TEMPLATE, TemplateError, buildMessage, validateTemplate } from '../src/core/messages.js';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const COOKIE = 'roster_sid';
const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

export function createApp({ store, secureCookies = false, today = () => todayIso(), log = console }) {
  const app = express();
  app.disable('x-powered-by');
  app.use(helmet({ contentSecurityPolicy: { directives: { 'script-src': ["'self'"], 'img-src': ["'self'", 'data:'] } } }));
  app.use(express.json({ limit: '10kb' }));
  app.use(express.static(PUBLIC_DIR, { index: 'index.html' }));
  // The browser shares these pure core modules (no Node APIs) — an explicit allowlist, not the folder.
  for (const file of ['dates.js', 'filters.js', 'week.js', 'shifts.js']) {
    app.get(`/core/${file}`, (req, res) => res.type('text/javascript').sendFile(path.join(PUBLIC_DIR, '..', 'src', 'core', file)));
  }

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

  app.post('/api/roster', (req, res, next) => {
    upload.single('file')(req, res, async (err) => {
      if (err) {
        const message = err.code === 'LIMIT_FILE_SIZE' ? 'הקובץ גדול מ־5MB.' : 'העלאת הקובץ נכשלה.';
        return res.status(400).json({ error: 'upload', message });
      }
      if (!req.file) return res.status(400).json({ error: 'upload', message: 'לא נבחר קובץ.' });
      const fileName = decodeFileName(req.file.originalname);
      const buf = req.file.buffer;
      if (!/\.xlsx$/i.test(fileName) || buf.length < 4 || buf[0] !== 0x50 || buf[1] !== 0x4b) {
        return res.status(400).json({ error: 'format', message: 'יש להעלות קובץ Excel בפורמט ‎.xlsx‎.' });
      }
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
        session = store.get(token);
      }
      // Replace everything from any previous upload — no stale posts or assignments survive.
      session.data = { fileName, buffer: buf, roster };
      setCookie(res, token);
      res.status(201).json(roster);
    });
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
    if (rosterVersion !== roster.version) {
      return res.status(409).json({ error: 'stale', message: 'השיבוץ הוחלף מאז שהמסך נטען. יש לרענן את הנתונים.' });
    }
    try {
      res.json(searchOnDuty(roster, roster.options, { date, hour, postId }));
    } catch (e) {
      if (e instanceof SearchError) return res.status(400).json({ error: 'query', message: e.message });
      throw e;
    }
  });

  // ---- Messages (preview only; sending is not implemented yet) ----
  const templateOf = (session) => session.template || DEFAULT_TEMPLATE;

  app.get('/api/messages/template', requireRoster, (req, res) => {
    res.json({ template: templateOf(req.session), defaults: DEFAULT_TEMPLATE });
  });

  app.put('/api/messages/template', requireRoster, (req, res) => {
    const { template } = req.body || {};
    if (template === null) {
      req.session.template = null;
      return res.json({ template: DEFAULT_TEMPLATE, defaults: DEFAULT_TEMPLATE });
    }
    try {
      req.session.template = validateTemplate(template);
      res.json({ template: req.session.template, defaults: DEFAULT_TEMPLATE });
    } catch (e) {
      if (e instanceof TemplateError) return res.status(400).json({ error: 'template', message: e.message });
      throw e;
    }
  });

  app.post('/api/messages/preview', requireRoster, (req, res) => {
    const { personKeys, rosterVersion } = req.body || {};
    const { roster } = req.session.data;
    if (rosterVersion !== roster.version) {
      return res.status(409).json({ error: 'stale', message: 'השיבוץ הוחלף מאז שהמסך נטען. יש לרענן את הנתונים.' });
    }
    if (!Array.isArray(personKeys) || personKeys.length === 0 || personKeys.length > 1000) {
      return res.status(400).json({ error: 'query', message: 'לא נבחרו חיילים.' });
    }
    const soldiers = new Map(roster.soldiers.map((s) => [s.key, s]));
    const byId = new Map(roster.assignments.map((a) => [a.id, a]));
    const template = templateOf(req.session);
    const messages = [];
    for (const key of personKeys) {
      const soldier = soldiers.get(key);
      if (!soldier) return res.status(400).json({ error: 'query', message: 'חייל שנבחר אינו קיים בשיבוץ הנוכחי.' });
      const msg = buildMessage(soldier, soldier.assignmentIds.map((id) => byId.get(id)), template);
      messages.push({ key, name: soldier.name, ...msg });
    }
    res.json({ messages });
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
