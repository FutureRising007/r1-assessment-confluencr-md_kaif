import { Pool } from 'pg';
import { config } from '../../src/config';
import { createPool } from '../../src/db';

/**
 * Shared pool for an integration test file plus a reset between tests.
 * TRUNCATE bypasses the row-level immutability triggers, which is exactly
 * what we want for test isolation (the API itself can never do this).
 */
export function useTestDb(): () => Pool {
  let pool: Pool;
  beforeAll(() => {
    pool = createPool(config.testDatabaseUrl);
  });
  beforeEach(async () => {
    await pool.query('TRUNCATE transactions, transfers, accounts RESTART IDENTITY CASCADE');
  });
  afterAll(async () => {
    await pool.end();
  });
  return () => pool;
}

export async function catchErr<T = any>(p: Promise<unknown>): Promise<T> {
  try {
    await p;
  } catch (e) {
    return e as T;
  }
  throw new Error('expected promise to reject');
}
