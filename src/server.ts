import { createApp } from './app';
import { config } from './config';
import { createPool, migrate } from './db';

async function main() {
  const pool = createPool(config.databaseUrl);
  await migrate(pool);

  const app = createApp(pool);
  const server = app.listen(config.port, () => {
    console.log(`Ledger API listening on http://localhost:${config.port} (docs: /docs)`);
  });

  const shutdown = () => {
    server.close(() => pool.end().then(() => process.exit(0)));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('Failed to start:', err);
  process.exit(1);
});
