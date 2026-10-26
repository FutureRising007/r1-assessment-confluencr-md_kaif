import { apiClient, expectErrorShape } from './helpers';
import { useTestDb } from '../../setup/testDb';

describe('Transactions API', () => {
  const db = useTestDb();
  let ctx: ReturnType<typeof apiClient>;
  let accountId: string;

  beforeEach(async () => {
    ctx = apiClient(db());
    accountId = (await ctx.createAccount()).id;
  });

  const balanceOf = () => ctx.balanceOf(accountId);

  describe('POST /accounts/:id/transactions', () => {
    it('201 - credit increases balance', async () => {
      await ctx.addTx(accountId, 'credit', 100);
      const res = await ctx.addTx(accountId, 'credit', 50);
      expect(res.status).toBe(201);
      expect(res.body.transaction).toMatchObject({ account_id: accountId, type: 'credit', amount: 50 });
      expect(res.body.balance).toBe(150);
    });

    it('201 - debit decreases balance', async () => {
      await ctx.addTx(accountId, 'credit', 100);
      const res = await ctx.addTx(accountId, 'debit', 30);
      expect(res.status).toBe(201);
      expect(res.body.balance).toBe(70);
    });

    it('422 - debit with insufficient balance is rejected, balance unchanged', async () => {
      await ctx.addTx(accountId, 'credit', 100);
      const res = await ctx.addTx(accountId, 'debit', 150);
      expect(res.status).toBe(422);
      expectErrorShape(res.body, 'INSUFFICIENT_BALANCE');
      expect(await balanceOf()).toBe(100);
    });

    it('409 - duplicate reference_id on same account: no new tx, balance unchanged', async () => {
      const first = await ctx.addTx(accountId, 'credit', 100, 'order-1');
      const dup = await ctx.addTx(accountId, 'credit', 100, 'order-1');
      expect(dup.status).toBe(409);
      expectErrorShape(dup.body, 'DUPLICATE_TRANSACTION');
      expect(dup.body.error.details.existing_transaction).toEqual(first.body.transaction);
      expect(await balanceOf()).toBe(100);
      const history = await ctx.api.get(`/accounts/${accountId}/transactions`);
      expect(history.body.pagination.total_records).toBe(1);
    });

    it('201 - same reference_id allowed on a different account', async () => {
      const other = (await ctx.createAccount('Bob')).id;
      await ctx.addTx(accountId, 'credit', 10, 'shared');
      const res = await ctx.addTx(other, 'credit', 10, 'shared');
      expect(res.status).toBe(201);
    });

    it('404 - account does not exist', async () => {
      const res = await ctx.addTx('missing', 'credit', 10);
      expect(res.status).toBe(404);
      expectErrorShape(res.body, 'ACCOUNT_NOT_FOUND');
    });

    it.each([
      ['invalid type', { type: 'refund', amount: 10, reference_id: 'x' }],
      ['zero amount', { type: 'credit', amount: 0, reference_id: 'x' }],
      ['negative amount', { type: 'credit', amount: -10, reference_id: 'x' }],
      ['amount as string', { type: 'credit', amount: '10', reference_id: 'x' }],
      ['missing reference_id', { type: 'credit', amount: 10 }],
      ['unknown field', { type: 'credit', amount: 10, reference_id: 'x', balance: 5 }],
    ])('400 - %s', async (_label, body) => {
      const res = await ctx.api.post(`/accounts/${accountId}/transactions`).send(body);
      expect(res.status).toBe(400);
      expectErrorShape(res.body, 'VALIDATION_ERROR');
      expect(Array.isArray(res.body.error.details)).toBe(true);
      expect(await balanceOf()).toBe(0);
    });

    it('spec example: +100 +50 -30 -20 = 100, failed tx has no effect', async () => {
      await ctx.addTx(accountId, 'credit', 100);
      await ctx.addTx(accountId, 'credit', 50);
      await ctx.addTx(accountId, 'debit', 30);
      await ctx.addTx(accountId, 'debit', 20);
      expect((await ctx.addTx(accountId, 'debit', 500)).status).toBe(422);
      expect(await balanceOf()).toBe(100);
    });
  });

  describe('immutability', () => {
    it.each(['put', 'patch', 'delete'] as const)('405 - %s on a transaction is not allowed', async (method) => {
      const tx = (await ctx.addTx(accountId, 'credit', 10)).body.transaction;
      const res = await ctx.api[method](`/accounts/${accountId}/transactions/${tx.id}`).send({ amount: 1 });
      expect(res.status).toBe(405);
      expectErrorShape(res.body, 'METHOD_NOT_ALLOWED');
      expect(await balanceOf()).toBe(10);
    });
  });

  describe('GET /accounts/:id/transactions', () => {
    beforeEach(async () => {
      await ctx.addTx(accountId, 'credit', 100, 'r1');
      await ctx.addTx(accountId, 'debit', 10, 'r2');
      await ctx.addTx(accountId, 'credit', 20, 'r3');
      await ctx.addTx(accountId, 'debit', 5, 'r4');
      await ctx.addTx(accountId, 'credit', 1, 'r5');
    });

    it('200 - all transactions latest-first with default pagination', async () => {
      const res = await ctx.api.get(`/accounts/${accountId}/transactions`);
      expect(res.status).toBe(200);
      expect(res.body.data.map((t: any) => t.reference_id)).toEqual(['r5', 'r4', 'r3', 'r2', 'r1']);
      expect(res.body.pagination).toEqual({ page: 1, limit: 10, total_records: 5, total_pages: 1 });
    });

    it('200 - filters by type', async () => {
      const res = await ctx.api.get(`/accounts/${accountId}/transactions?type=credit`);
      expect(res.body.data.every((t: any) => t.type === 'credit')).toBe(true);
      expect(res.body.pagination.total_records).toBe(3);
    });

    it('200 - paginates', async () => {
      const res = await ctx.api.get(`/accounts/${accountId}/transactions?page=3&limit=2`);
      expect(res.body.data.map((t: any) => t.reference_id)).toEqual(['r1']);
      expect(res.body.pagination).toEqual({ page: 3, limit: 2, total_records: 5, total_pages: 3 });
    });

    it.each(['page=0', 'page=abc', 'limit=0', 'limit=1000', 'page=1.5'])(
      '400 - invalid pagination (%s)',
      async (qs) => {
        const res = await ctx.api.get(`/accounts/${accountId}/transactions?${qs}`);
        expect(res.status).toBe(400);
        expectErrorShape(res.body, 'INVALID_PAGINATION');
      },
    );

    it('400 - invalid type filter', async () => {
      const res = await ctx.api.get(`/accounts/${accountId}/transactions?type=refund`);
      expect(res.status).toBe(400);
      expectErrorShape(res.body, 'VALIDATION_ERROR');
    });

    it('404 - unknown account', async () => {
      const res = await ctx.api.get('/accounts/missing/transactions');
      expect(res.status).toBe(404);
      expectErrorShape(res.body, 'ACCOUNT_NOT_FOUND');
    });
  });
});
