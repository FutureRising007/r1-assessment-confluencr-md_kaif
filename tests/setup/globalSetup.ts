import { Client } from 'pg';
import { config } from '../../src/config';
import { createPool, migrate } from '../../src/db';

/** Creates the test database (if missing) and applies the schema once per test run. */
export default async function globalSetup() {
  const url = new URL(config.testDatabaseUrl);
  const dbName = url.pathname.slice(1);
  url.pathname = '/postgres';

  const admin = new Client({ connectionString: url.toString() });
  await admin.connect();
  const exists = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [dbName]);
  if (exists.rowCount === 0) await admin.query(`CREATE DATABASE "${dbName.replace(/"/g, '')}"`);
  await admin.end();

  const pool = createPool(config.testDatabaseUrl);
  await migrate(pool);
  await pool.end();
}
