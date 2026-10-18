import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is not set');
  process.exit(1);
}
const dir = path.resolve(import.meta.dirname, '../server/migrations');
const files = fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort();
const client = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: true } });
try {
  await client.connect();
  for (const f of files) await client.query(fs.readFileSync(path.join(dir, f), 'utf8'));
  console.log('migrations applied');
} catch (e) {
  console.error('migration failed:', e.code || e.name); // never print the connection string
  process.exitCode = 1;
} finally {
  await client.end().catch(() => {});
}
