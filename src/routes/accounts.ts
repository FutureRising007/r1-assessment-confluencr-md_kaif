import { Router } from 'express';
import { AppError } from '../errors';
import { parse } from '../middleware/validate';
import { validationError } from '../middleware/errorHandler';
import { AccountService } from '../services/accountService';
import { TransactionService } from '../services/transactionService';
import { createAccountSchema, createTransactionSchema, historyQuerySchema } from '../validation/schemas';

// Express 5 forwards rejected promises from async handlers to the error handler.
export function accountsRouter(accounts: AccountService, transactions: TransactionService): Router {
  const router = Router();

  router.post('/', async (req, res) => {
    const { name } = parse(createAccountSchema, req.body);
    const account = await accounts.create(name);
    res.status(201).location(`/accounts/${account.id}`).json(account);
  });

  router.get('/:id', async (req, res) => {
    res.json(await accounts.get(req.params.id));
  });

  router.get('/:id/balance', async (req, res) => {
    res.json(await accounts.getBalance(req.params.id));
  });

  router.post('/:id/transactions', async (req, res) => {
    const input = parse(createTransactionSchema, req.body);
    res.status(201).json(await transactions.create(req.params.id, input));
  });

  router.get('/:id/transactions', async (req, res) => {
    const parsed = historyQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      const onlyPaging = parsed.error.issues.every((i) => i.path[0] === 'page' || i.path[0] === 'limit');
      throw validationError(parsed.error, onlyPaging ? 'INVALID_PAGINATION' : 'VALIDATION_ERROR');
    }
    res.json(await transactions.list(req.params.id, parsed.data));
  });

  // Transactions are immutable: make that explicit rather than a generic 404.
  router.all('/:id/transactions/:txId', (req, _res, next) => {
    if (req.method === 'GET') return next();
    throw new AppError(405, 'METHOD_NOT_ALLOWED', 'Transactions are immutable and cannot be modified or deleted');
  });

  return router;
}
