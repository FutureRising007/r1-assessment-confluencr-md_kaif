import 'dotenv/config';

export const config = {
  port: Number(process.env.PORT ?? 3000),
  databaseUrl: process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/ledger',
  testDatabaseUrl: process.env.TEST_DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/ledger_test',
};
