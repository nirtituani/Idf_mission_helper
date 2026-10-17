// In-memory session store. Rosters never touch disk: the uploaded file and its parsed data live
// only in this process's memory and are dropped on expiry, explicit deletion, or restart.
//
// The browser holds a random 256-bit token (HttpOnly cookie). The store is keyed by the token's
// SHA-256, so the raw token never sits in the map and session data is reachable only by the
// holder of the cookie — there are no guessable ids in URLs.
import crypto from 'node:crypto';

const hash = (token) => crypto.createHash('sha256').update(token).digest('hex');

// maxSessions caps memory use on a public server: when full (after dropping expired sessions),
// create() returns null and the caller refuses the new visitor instead of evicting someone else.
export function createSessionStore({ idleTtlMs, maxAgeMs, maxSessions = Infinity, now = Date.now }) {
  const sessions = new Map();

  const expired = (s) => now() - s.lastAccess > idleTtlMs || now() - s.createdAt > maxAgeMs;

  const store = {
    create() {
      if (sessions.size >= maxSessions) store.sweep();
      if (sessions.size >= maxSessions) return null;
      const token = crypto.randomBytes(32).toString('base64url');
      sessions.set(hash(token), { createdAt: now(), lastAccess: now(), data: null });
      return token;
    },
    get(token) {
      if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
      const key = hash(token);
      const s = sessions.get(key);
      if (!s) return null;
      if (expired(s)) {
        sessions.delete(key);
        return null;
      }
      s.lastAccess = now();
      return s;
    },
    destroy(token) {
      if (typeof token === 'string') sessions.delete(hash(token));
    },
    sweep() {
      let removed = 0;
      for (const [key, s] of sessions) {
        if (expired(s)) {
          sessions.delete(key);
          removed++;
        }
      }
      return removed;
    },
    size: () => sessions.size,
  };
  return store;
}
