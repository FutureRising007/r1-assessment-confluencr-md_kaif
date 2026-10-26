import { apiClient, expectErrorShape } from './helpers';
import { useTestDb } from '../../setup/testDb';

describe('Accounts API', () => {
  const db = useTestDb();
  let ctx: ReturnType<typeof apiClient>;
  beforeEach(() => {
    ctx = apiClient(db());
  });

  describe('POST /accounts', () => {
    it('201 - creates an account with balance 0', async () => {
      const res = await ctx.api.post('/accounts').send({ name: 'Alice' });
      expect(res.status).toBe(201);
      expect(res.body).toEqual({
        id: expect.any(String),
        name: 'Alice',
        balance: 0,
        created_at: expect.any(String),
      });
      expect(res.headers.location).toBe(`/accounts/${res.body.id}`);
    });

    it('400 - client cannot set initial balance', async () => {
      const res = await ctx.api.post('/accounts').send({ name: 'Alice', balance: 1000 });
      expect(res.status).toBe(400);
      expectErrorShape(res.body, 'VALIDATION_ERROR');
      expect(res.body.error.details).toEqual(
        expect.arrayContaining([expect.objectContaining({ field: expect.stringContaining('balance') })]),
      );
    });

    it('400 - name is required', async () => {
      const res = await ctx.api.post('/accounts').send({});
      expect(res.status).toBe(400);
      expectErrorShape(res.body, 'VALIDATION_ERROR');
      expect(res.body.error.details[0].field).toBe('name');
    });

    it('400 - malformed JSON body', async () => {
      const res = await ctx.api.post('/accounts').set('Content-Type', 'application/json').send('{"name": ');
      expect(res.status).toBe(400);
      expectErrorShape(res.body, 'INVALID_JSON');
    });

    it('400 - non-object JSON body', async () => {
      const res = await ctx.api.post('/accounts').send(['Alice']);
      expect(res.status).toBe(400);
      expectErrorShape(res.body, 'VALIDATION_ERROR');
    });
  });

  describe('GET /accounts/:id', () => {
    it('200 - returns the account', async () => {
      const acc = await ctx.createAccount('Bob');
      const res = await ctx.api.get(`/accounts/${acc.id}`);
      expect(res.status).toBe(200);
      expect(res.body).toEqual(acc);
    });

    it('404 - unknown account', async () => {
      const res = await ctx.api.get('/accounts/does-not-exist');
      expect(res.status).toBe(404);
      expectErrorShape(res.body, 'ACCOUNT_NOT_FOUND');
    });
  });

  describe('GET /accounts/:id/balance', () => {
    it('200 - returns account_id and balance', async () => {
      const acc = await ctx.createAccount();
      await ctx.addTx(acc.id, 'credit', 75.25);
      const res = await ctx.api.get(`/accounts/${acc.id}/balance`);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ account_id: acc.id, balance: 75.25 });
    });

    it('404 - unknown account', async () => {
      const res = await ctx.api.get('/accounts/nope/balance');
      expect(res.status).toBe(404);
      expectErrorShape(res.body, 'ACCOUNT_NOT_FOUND');
    });
  });

  it('404 - unknown route uses the same error envelope', async () => {
    const res = await ctx.api.get('/nothing-here');
    expect(res.status).toBe(404);
    expectErrorShape(res.body, 'NOT_FOUND');
  });

  it('GET /health', async () => {
    const res = await ctx.api.get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
  });
});
