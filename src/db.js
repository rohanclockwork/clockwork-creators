import pg from 'pg';
import { config } from './config.js';

// BIGINT (paise) as JS numbers. Safe: paise totals stay far below 2^53.
pg.types.setTypeParser(20, (v) => (v === null ? null : Number(v)));

export const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  ssl: config.databaseUrl.includes('localhost') || config.databaseUrl.includes('127.0.0.1') ? false : { rejectUnauthorized: false },
  max: 10,
});

export const q = (text, params) => pool.query(text, params);

export async function tx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

export async function audit(actor, entity, entityId, action, before, after, client = pool) {
  await client.query(
    'INSERT INTO audit_log (actor, entity, entity_id, action, before, after) VALUES ($1,$2,$3,$4,$5,$6)',
    [actor, entity, String(entityId), action, before ? JSON.stringify(before) : null, after ? JSON.stringify(after) : null],
  );
}

// A job lock: only one instance of a named job runs at a time, and it can't overlap itself.
export async function withLock(name, fn) {
  const got = await q(
    `INSERT INTO job_locks (name) VALUES ($1)
     ON CONFLICT (name) DO UPDATE SET locked_at = now() WHERE job_locks.locked_at < now() - interval '2 hours'
     RETURNING name`,
    [name],
  );
  if (!got.rowCount) return { skipped: true };
  try {
    return await fn();
  } finally {
    await q('DELETE FROM job_locks WHERE name = $1', [name]);
  }
}
