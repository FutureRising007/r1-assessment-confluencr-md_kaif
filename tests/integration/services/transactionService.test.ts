import { AccountService } from '../../../src/services/accountService';
import { TransactionService } from '../../../src/services/transactionService';
import { AppError } from '../../../src/errors';
import { useTestDb, catchErr } from '../../setup/testDb';

describe('TransactionService (PostgreSQL)', () => {
  const db = useTestDb();
  let accounts: AccountService;
  let txs: TransactionService;
  let accountId: string;
  let refCounter = 0;
  const ref = () => `ref-${++refCounter}`;
  const balance = async () => (await accounts.getBalance(accountId)).balance;
  const count = async () => (await txs.list(accountId, { page: 1, limit: 100 })).pagination.total_records;

  beforeEach(async () => {
    accounts = new AccountService(db());
    txs = new TransactionService(db(), accounts);
    accountId = (await accounts.create('Alice')).id;
  });

  describe('credit', () => {
    it('increases balance by the amount (100 + 50 = 150)', async () => {
      await txs.create(accountId, { type: 'credit', amount: 100, reference_id: ref() });
      const result = await txs.create(accountId, { type: 'credit', amount: 50, reference_id: ref() });
      expect(result.balance).toBe(150);
      expect(await balance()).toBe(150);
    });

    it('returns the created transaction with all required fields', async () => {
      const { transaction } = await txs.create(accountId, {
        type: 'credit',
        amount: 10.5,
        description: 'Top-up',
        reference_id: 'abc',
      });
      expect(transaction).toEqual({
        id: expect.any(String),
        account_id: accountId,
        type: 'credit',
        amount: 10.5,
        description: 'Top-up',
        reference_id: 'abc',
        transfer_id: null,
        created_at: expect.any(String),
      });
    });
  });

  describe('debit', () => {
    beforeEach(() => txs.create(accountId, { type: 'credit', amount: 100, reference_id: 'seed' }));

    it('decreases balance by the amount (100 - 30 = 70)', async () => {
      expect((await txs.create(accountId, { type: 'debit', amount: 30, reference_id: ref() })).balance).toBe(70);
    });

    it('allows debiting the exact full balance', async () => {
      expect((await txs.create(accountId, { type: 'debit', amount: 100, reference_id: ref() })).balance).toBe(0);
    });

    it('rejects debit exceeding balance; balance and history unchanged', async () => {
      const err = await catchErr<AppError>(txs.create(accountId, { type: 'debit', amount: 150, reference_id: ref() }));
      expect(err.code).toBe('INSUFFICIENT_BALANCE');
      expect(err.status).toBe(422);
      expect(await balance()).toBe(100);
      expect(await count()).toBe(1);
    });
  });

  describe('duplicates (idempotency by reference_id)', () => {
    it('rejects a repeated reference_id on the same account without changing balance', async () => {
      const first = await txs.create(accountId, { type: 'credit', amount: 100, reference_id: 'dup' });
      const err = await catchErr<AppError>(txs.create(accountId, { type: 'credit', amount: 100, reference_id: 'dup' }));
      expect(err.code).toBe('DUPLICATE_TRANSACTION');
      expect(err.status).toBe(409);
      expect((err.details as any).existing_transaction).toEqual(first.transaction);
      expect(await balance()).toBe(100);
      expect(await count()).toBe(1);
    });

    it('treats a repeat as duplicate even if the payload differs', async () => {
      await txs.create(accountId, { type: 'credit', amount: 100, reference_id: 'dup' });
      const err = await catchErr<AppError>(txs.create(accountId, { type: 'debit', amount: 1, reference_id: 'dup' }));
      expect(err.code).toBe('DUPLICATE_TRANSACTION');
      expect(await balance()).toBe(100);
    });

    it('allows the same reference_id on a different account', async () => {
      const other = (await accounts.create('Bob')).id;
      await txs.create(accountId, { type: 'credit', amount: 10, reference_id: 'shared' });
      await expect(txs.create(other, { type: 'credit', amount: 10, reference_id: 'shared' })).resolves.toBeDefined();
    });

    it('a rejected (insufficient) debit does not consume the reference_id', async () => {
      await expect(txs.create(accountId, { type: 'debit', amount: 5, reference_id: 'retry' })).rejects.toThrow();
      await txs.create(accountId, { type: 'credit', amount: 10, reference_id: ref() });
      expect((await txs.create(accountId, { type: 'debit', amount: 5, reference_id: 'retry' })).balance).toBe(5);
    });

    it('concurrent submissions of the same reference create exactly one transaction', async () => {
      const results = await Promise.allSettled(
        Array.from({ length: 10 }, () => txs.create(accountId, { type: 'credit', amount: 10, reference_id: 'race' })),
      );
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
      expect(rejected.every((r) => r.reason.code === 'DUPLICATE_TRANSACTION')).toBe(true);
      expect(await balance()).toBe(10);
    });
  });

  it('throws ACCOUNT_NOT_FOUND for an unknown account', async () => {
    const err = await catchErr<AppError>(
      txs.create('00000000-0000-0000-0000-000000000000', { type: 'credit', amount: 1, reference_id: ref() }),
    );
    expect(err.code).toBe('ACCOUNT_NOT_FOUND');
  });

  it('balance equals the sum of all valid transactions (spec example: final 100)', async () => {
    await txs.create(accountId, { type: 'credit', amount: 100, reference_id: ref() });
    await txs.create(accountId, { type: 'credit', amount: 50, reference_id: ref() });
    await txs.create(accountId, { type: 'debit', amount: 30, reference_id: ref() });
    await txs.create(accountId, { type: 'debit', amount: 20, reference_id: ref() });
    await expect(txs.create(accountId, { type: 'debit', amount: 1000, reference_id: ref() })).rejects.toThrow();
    expect(await balance()).toBe(100);
    expect(await txs.computeBalanceFromLedger(accountId)).toBe(100);
  });

  it('handles decimal amounts exactly (0.1 + 0.2 = 0.3)', async () => {
    await txs.create(accountId, { type: 'credit', amount: 0.1, reference_id: ref() });
    expect((await txs.create(accountId, { type: 'credit', amount: 0.2, reference_id: ref() })).balance).toBe(0.3);
  });

  describe('balance precision limit', () => {
    const MAX = Number.MAX_SAFE_INTEGER; // largest integer a JS number holds exactly

    it('rejects a credit that would push the balance beyond exact-precision range; balance unchanged', async () => {
      await db().query('UPDATE accounts SET balance_minor = $1 WHERE id = $2', [MAX - 50, accountId]);
      const err = await catchErr<AppError>(txs.create(accountId, { type: 'credit', amount: 1, reference_id: ref() }));
      expect(err.code).toBe('BALANCE_LIMIT_EXCEEDED');
      expect(err.status).toBe(422);
      expect((await db().query('SELECT balance_minor FROM accounts WHERE id = $1', [accountId])).rows[0].balance_minor).toBe(
        MAX - 50,
      );
      expect(await count()).toBe(0);
    });

    it('database CHECK also caps the balance at 2^53 - 1', async () => {
      await expect(
        db().query('UPDATE accounts SET balance_minor = $1::bigint + 1 WHERE id = $2', [MAX, accountId]),
      ).rejects.toThrow(/check constraint/);
    });
  });

  describe('concurrency', () => {
    it('parallel debits never overdraw: 50 balance, 80 debits of 1 => exactly 50 succeed', async () => {
      await txs.create(accountId, { type: 'credit', amount: 50, reference_id: 'seed' });
      const results = await Promise.allSettled(
        Array.from({ length: 80 }, (_, i) => txs.create(accountId, { type: 'debit', amount: 1, reference_id: `d-${i}` })),
      );
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(50);
      expect(await balance()).toBe(0);
      expect(await txs.computeBalanceFromLedger(accountId)).toBe(0);
    });
  });

  describe('atomicity', () => {
    it('rolls back the transaction insert if the balance update fails', async () => {
      // Force the balance UPDATE to fail after the INSERT has already succeeded.
      await db().query(`
        CREATE OR REPLACE FUNCTION test_fail() RETURNS trigger AS $$
        BEGIN RAISE EXCEPTION 'boom'; END; $$ LANGUAGE plpgsql;
        CREATE TRIGGER test_fail_balance BEFORE UPDATE ON accounts FOR EACH ROW EXECUTE FUNCTION test_fail();`);
      try {
        await expect(txs.create(accountId, { type: 'credit', amount: 10, reference_id: 'atomic' })).rejects.toThrow(/boom/);
      } finally {
        await db().query('DROP TRIGGER test_fail_balance ON accounts; DROP FUNCTION test_fail();');
      }
      expect(await count()).toBe(0);
      expect(await balance()).toBe(0);
    });
  });

  describe('immutability (enforced by the database)', () => {
    it('blocks UPDATE and DELETE on transactions', async () => {
      const { transaction } = await txs.create(accountId, { type: 'credit', amount: 10, reference_id: ref() });
      await expect(db().query('UPDATE transactions SET amount_minor = 1 WHERE id = $1', [transaction.id])).rejects.toThrow(
        /immutable/,
      );
      await expect(db().query('DELETE FROM transactions WHERE id = $1', [transaction.id])).rejects.toThrow(/immutable/);
    });
  });

  describe('list (history)', () => {
    beforeEach(async () => {
      // Sequential so the order is deterministic: 3 credits, 2 debits.
      await txs.create(accountId, { type: 'credit', amount: 100, reference_id: 'r1' });
      await txs.create(accountId, { type: 'debit', amount: 10, reference_id: 'r2' });
      await txs.create(accountId, { type: 'credit', amount: 20, reference_id: 'r3' });
      await txs.create(accountId, { type: 'debit', amount: 5, reference_id: 'r4' });
      await txs.create(accountId, { type: 'credit', amount: 1, reference_id: 'r5' });
    });

    it('returns latest-first ordering', async () => {
      const { data } = await txs.list(accountId, { page: 1, limit: 10 });
      expect(data.map((t) => t.reference_id)).toEqual(['r5', 'r4', 'r3', 'r2', 'r1']);
    });

    it('filters by type', async () => {
      const debits = await txs.list(accountId, { page: 1, limit: 10, type: 'debit' });
      expect(debits.data.map((t) => t.reference_id)).toEqual(['r4', 'r2']);
      expect(debits.pagination.total_records).toBe(2);
    });

    it('paginates with metadata', async () => {
      const page2 = await txs.list(accountId, { page: 2, limit: 2 });
      expect(page2.data.map((t) => t.reference_id)).toEqual(['r3', 'r2']);
      expect(page2.pagination).toEqual({ page: 2, limit: 2, total_records: 5, total_pages: 3 });
    });

    it('returns an empty page beyond the last page', async () => {
      const res = await txs.list(accountId, { page: 10, limit: 2 });
      expect(res.data).toEqual([]);
      expect(res.pagination.total_pages).toBe(3);
    });

    it('throws ACCOUNT_NOT_FOUND for unknown account', async () => {
      expect((await catchErr<AppError>(txs.list('missing', { page: 1, limit: 10 }))).code).toBe('ACCOUNT_NOT_FOUND');
    });

    it('count and page come from one consistent snapshot even if a write lands in between', async () => {
      // Wrap the pool so a new transaction is committed (on another connection)
      // right after the COUNT query runs and before the page query.
      const pool = db();
      let fired = false;
      const hook = (target: any) => async (...args: any[]) => {
        const result = await target.query(...args);
        if (!fired && /COUNT\(\*\)/.test(String(args[0]))) {
          fired = true;
          await txs.create(accountId, { type: 'credit', amount: 7, reference_id: 'late' });
        }
        return result;
      };
      const wrap = (obj: any, extra: Record<string, unknown>) =>
        new Proxy(obj, {
          get(t, p) {
            if (p in extra) return extra[p as string];
            const v = t[p];
            return typeof v === 'function' ? v.bind(t) : v;
          },
        });
      const hookedPool = wrap(pool, {
        query: hook(pool),
        connect: async () => {
          const client = await pool.connect();
          return wrap(client, { query: hook(client) });
        },
      });

      const result = await new TransactionService(hookedPool, accounts).list(accountId, { page: 1, limit: 100 });
      expect(fired).toBe(true);
      expect(result.pagination.total_records).toBe(result.data.length);
      expect(result.pagination.total_records).toBe(5);
    });
  });
});
