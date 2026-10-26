import express, { Express } from 'express';
import { DB } from './db';
import { errorHandler, notFoundHandler } from './middleware/errorHandler';
import { accountsRouter } from './routes/accounts';
import { docsRouter } from './routes/docs';
import { transfersRouter } from './routes/transfers';
import { AccountService } from './services/accountService';
import { TransactionService } from './services/transactionService';
import { TransferService } from './services/transferService';

/** Builds the Express app around an injected DB so tests can use an in-memory instance. */
export function createApp(db: DB): Express {
  const accounts = new AccountService(db);
  const transactions = new TransactionService(db, accounts);
  const transfers = new TransferService(db, accounts, transactions);

  const app = express();
  app.use(express.json({ limit: '100kb' }));

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });
  app.use('/docs', docsRouter());
  app.use('/accounts', accountsRouter(accounts, transactions));
  app.use('/transfers', transfersRouter(transfers));

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
