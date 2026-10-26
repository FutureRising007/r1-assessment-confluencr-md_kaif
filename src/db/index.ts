import fs from 'fs';
import path from 'path';
import { Pool, PoolClient, types } from 'pg';

/**
 * BIGINT (oid 20) comes back as a string by default. Balances are capped at 2^53 - 1
 * by a CHECK constraint, so conversion is exact; anything larger fails loudly
 * rather than being silently rounded.
 */
export function parseBigint(value: string): number {
  const n = Number(value);
  if (!Number.isSafeInteger(n)) throw new Error(`BIGINT ${value} exceeds JavaScript integer precision`);
  return n;
}

types.setTypeParser(20, parseBigint);

export type DB = Pool;
export type Executor = Pool | PoolClient;

const SCHEMA_PATH = path.join(__dirname, 'schema.sql');

export function createPool(connectionString: string): Pool {
  return new Pool({ connectionString, max: 10 });
}

export async function migrate(pool: Pool): Promise<void> {
  // Serialise concurrent migrations (e.g. parallel test workers) with an advisory lock.
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock(727274)');
    await client.query(fs.readFileSync(SCHEMA_PATH, 'utf8'));
  } finally {
    await client.query('SELECT pg_advisory_unlock(727274)').catch(() => undefined);
    client.release();
  }
}

/**
 * Runs fn inside a single database transaction. Any thrown error rolls back
 * every statement fn executed, which is how atomicity is guaranteed.
 */
export async function withTransaction<T>(
  pool: Pool,
  fn: (client: PoolClient) => Promise<T>,
  begin = 'BEGIN',
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query(begin);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
