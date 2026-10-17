import { createApp } from './app.js';
import { createSessionStore } from './sessions.js';

const hours = (h) => h * 60 * 60 * 1000;
const PORT = Number(process.env.PORT) || 3000;
const IDLE_HOURS = Number(process.env.SESSION_IDLE_HOURS) || 8;
const MAX_HOURS = Number(process.env.SESSION_MAX_HOURS) || 24;
const production = process.env.NODE_ENV === 'production';

const store = createSessionStore({ idleTtlMs: hours(IDLE_HOURS), maxAgeMs: hours(MAX_HOURS) });
setInterval(() => store.sweep(), 60 * 1000).unref();

const app = createApp({ store, secureCookies: production });
if (production) app.set('trust proxy', 1);

app.listen(PORT, () => {
  console.log(`duty-roster listening on http://localhost:${PORT} (session idle ${IDLE_HOURS}h, max ${MAX_HOURS}h)`);
});
