import { createApp } from './app.js';
import { createSessionStore } from './sessions.js';
import { loadConfig } from './config.js';
import { createCipher } from './crypto.js';
import { createMemoryRepo, createPgRepo } from './repo.js';
import { createFakeWhatsAppClient, createWhatsAppClient } from './whatsapp.js';

const hours = (h) => h * 60 * 60 * 1000;
const PORT = Number(process.env.PORT) || 3000;
const IDLE_HOURS = Number(process.env.SESSION_IDLE_HOURS) || 8;
const MAX_HOURS = Number(process.env.SESSION_MAX_HOURS) || 24;
const MAX_SESSIONS = Number(process.env.MAX_SESSIONS) || 40; // ~5 MB file + parsed data each
const production = process.env.NODE_ENV === 'production';

const store = createSessionStore({ idleTtlMs: hours(IDLE_HOURS), maxAgeMs: hours(MAX_HOURS), maxSessions: MAX_SESSIONS });
setInterval(() => store.sweep(), 60 * 1000).unref();

// WhatsApp sending only when every required env var is set; otherwise the site works as before.
const config = loadConfig(process.env);
const send = config.fake
  ? {
      // WA_FAKE=1 (never in production): memory repo + fake client, no webhook, nothing leaves the machine.
      wa: createFakeWhatsAppClient(),
      repo: createMemoryRepo(),
      sendCode: config.sendCode,
      testPhone: config.testPhone,
      sendEnabled: true,
    }
  : config.enabled
  ? {
      wa: createWhatsAppClient(config.wa),
      repo: createPgRepo({ databaseUrl: config.databaseUrl, cipher: createCipher(config.encKey) }),
      webhook: { appSecret: config.appSecret, verifyToken: config.verifyToken },
      sendCode: config.sendCode,
      testPhone: config.testPhone,
      sendEnabled: true,
    }
  : { sendEnabled: false };
if (config.fake) console.log('WhatsApp sending in FAKE mode (WA_FAKE=1): in-memory data, no real messages');
else if (!config.enabled) console.log(`WhatsApp sending disabled (missing or invalid: ${config.missing.join(', ')})`);

const app = createApp({ store, secureCookies: production, ...send });
if (production) app.set('trust proxy', 1); // one proxy hop (Render's load balancer) → real client IP

app.listen(PORT, () => {
  console.log(`duty-roster listening on http://localhost:${PORT} (session idle ${IDLE_HOURS}h, max ${MAX_HOURS}h)`);
});
