// Creates the app database (if missing) and applies the schema.
// Usage: npm run db:setup
import { Client } from 'pg';
import { config } from '../src/config';
import { createPool, migrate } from '../src/db';

async function ensureDatabase(connectionString: string) {
  const url = new URL(connectionString);
  const dbName = url.pathname.slice(1);
  url.pathname = '/postgres';
  const admin = new Client({ connectionString: url.toString() });
  await admin.connect();
  const exists = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [dbName]);
  if (exists.rowCount === 0) {
    await admin.query(`CREATE DATABASE "${dbName.replace(/"/g, '')}"`);
    console.log(`Created database ${dbName}`);
  }
  await admin.end();
}

async function main() {
  await ensureDatabase(config.databaseUrl);
  const pool = createPool(config.databaseUrl);
  await migrate(pool);
  await pool.end();
  console.log('Schema applied.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
