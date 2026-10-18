import pg from 'pg';

const RANK = { accepted: 0, sent: 1, delivered: 2, read: 3 };

export function createMemoryRepo() {
  let contacts = [];
  let contactsAt = null;
  const sends = new Map(); // `${weekStart}|${soldierKey}` -> row
  const id = (w, k) => `${w}|${k}`;
  const view = r => ({ status: r.status, error: r.error, paramsHash: r.paramsHash, sentAt: r.sentAt, statusAt: r.statusAt });

  return {
    async replaceContacts(list) {
      contacts = list.map(c => ({ name: c.name, phone: c.phone }));
      contactsAt = new Date();
    },
    async listContacts() { return contacts.map(c => ({ ...c })); },
    async contactsInfo() { return { count: contacts.length, updatedAt: contactsAt }; },
    async reserveSend({ weekStart, soldierKey, soldierName, paramsHash, resend }) {
      // check-and-insert is synchronous: no await between the lookup and the write
      const k = id(weekStart, soldierKey);
      const existing = sends.get(k);
      if (existing && !(resend && existing.status !== 'sending')) return { ok: false, existing: view(existing) };
      const now = new Date();
      sends.set(k, { weekStart, soldierKey, soldierName, paramsHash, wamid: null, status: 'sending', error: null, sentAt: now, statusAt: now });
      return { ok: true };
    },
    async completeSend({ weekStart, soldierKey, wamid, status, error }) {
      const r = sends.get(id(weekStart, soldierKey));
      if (!r) return;
      r.wamid = wamid ?? null;
      r.status = status;
      r.error = error ?? null;
      r.statusAt = new Date();
    },
    async listSends(weekStart) {
      const m = new Map();
      for (const r of sends.values()) if (r.weekStart === weekStart) m.set(r.soldierKey, view(r));
      return m;
    },
    async applyStatus({ wamid, status, error, at }) {
      if (!wamid) return;
      for (const r of sends.values()) {
        if (r.wamid !== wamid) continue;
        if (!shouldApply(r.status, status)) return;
        r.status = status;
        r.error = status === 'failed' ? (error ?? null) : r.error;
        r.statusAt = at ? new Date(at) : new Date();
        return;
      }
    },
  };
}

function shouldApply(current, next) {
  if (next === 'failed') return current !== 'read';
  if (!(next in RANK)) return false;
  if (current === 'failed') return false;
  return (RANK[current] ?? -1) < RANK[next];
}

export function createPgRepo({ databaseUrl, cipher }) {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 3, ssl: { rejectUnauthorized: true } });
  // dates come back as raw 'YYYY-MM-DD' strings (no timezone shift) for this pool only
  pool.on('connect', c => c.setTypeParser(1082, v => v));
  const SEL = `week_start, soldier_key, soldier_name, params_hash, wamid, status, error, sent_at, status_at`;
  const view = r => ({ status: r.status, error: r.error, paramsHash: r.params_hash, sentAt: r.sent_at, statusAt: r.status_at });

  return {
    async replaceContacts(list) {
      const c = await pool.connect();
      try {
        await c.query('BEGIN');
        await c.query('DELETE FROM contacts');
        for (const x of list) {
          await c.query('INSERT INTO contacts (name, phone_enc) VALUES ($1, $2)', [x.name, cipher.encrypt(x.phone)]);
        }
        await c.query('COMMIT');
      } catch (e) {
        await c.query('ROLLBACK').catch(() => {});
        throw e;
      } finally {
        c.release();
      }
    },
    async listContacts() {
      const { rows } = await pool.query('SELECT name, phone_enc FROM contacts ORDER BY id');
      return rows.map(r => ({ name: r.name, phone: cipher.decrypt(r.phone_enc) }));
    },
    async contactsInfo() {
      const { rows } = await pool.query('SELECT count(*)::int AS count, max(updated_at) AS updated_at FROM contacts');
      return { count: rows[0].count, updatedAt: rows[0].updated_at };
    },
    async reserveSend({ weekStart, soldierKey, soldierName, paramsHash, resend }) {
      const ins = await pool.query(
        `INSERT INTO sends (week_start, soldier_key, soldier_name, params_hash, wamid, status, error, sent_at, status_at)
         VALUES ($1, $2, $3, $4, NULL, 'sending', NULL, now(), now())
         ON CONFLICT (week_start, soldier_key) DO UPDATE
           SET soldier_name = EXCLUDED.soldier_name, params_hash = EXCLUDED.params_hash, wamid = NULL,
               status = 'sending', error = NULL, sent_at = now(), status_at = now()
           WHERE $5::boolean AND sends.status <> 'sending'
         RETURNING soldier_key`,
        [weekStart, soldierKey, soldierName, paramsHash, !!resend]);
      if (ins.rowCount === 1) return { ok: true };
      const { rows } = await pool.query(`SELECT ${SEL} FROM sends WHERE week_start = $1 AND soldier_key = $2`, [weekStart, soldierKey]);
      return { ok: false, existing: rows[0] ? view(rows[0]) : null };
    },
    async completeSend({ weekStart, soldierKey, wamid, status, error }) {
      await pool.query(
        `UPDATE sends SET wamid = $3, status = $4, error = $5, status_at = now() WHERE week_start = $1 AND soldier_key = $2`,
        [weekStart, soldierKey, wamid ?? null, status, error ?? null]);
    },
    async listSends(weekStart) {
      const { rows } = await pool.query(`SELECT ${SEL} FROM sends WHERE week_start = $1`, [weekStart]);
      return new Map(rows.map(r => [r.soldier_key, view(r)]));
    },
    async applyStatus({ wamid, status, error, at }) {
      if (!wamid) return;
      const when = at ? new Date(at) : new Date();
      if (status === 'failed') {
        await pool.query(
          `UPDATE sends SET status = 'failed', error = $2, status_at = $3 WHERE wamid = $1 AND status <> 'read'`,
          [wamid, error ?? null, when]);
        return;
      }
      if (!(status in RANK)) return;
      await pool.query(
        `UPDATE sends SET status = $2, status_at = $3
         WHERE wamid = $1 AND status IN ('accepted','sent','delivered','read')
           AND (CASE status WHEN 'accepted' THEN 0 WHEN 'sent' THEN 1 WHEN 'delivered' THEN 2 ELSE 3 END) < $4`,
        [wamid, status, when, RANK[status]]);
    },
    // test helper: wipe tables (only used by the TEST_DATABASE_URL contract run)
    async _reset() { await pool.query('TRUNCATE contacts, sends'); },
    async close() { await pool.end(); },
  };
}
