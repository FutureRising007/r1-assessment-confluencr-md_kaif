import { apiClient, expectErrorShape } from './helpers';
import { useTestDb } from '../../setup/testDb';

describe('Transfers API', () => {
  const db = useTestDb();
  let ctx: ReturnType<typeof apiClient>;
  let a: string;
  let b: string;

  beforeEach(async () => {
    ctx = apiClient(db());
    a = (await ctx.createAccount('A')).id;
    b = (await ctx.createAccount('B')).id;
    await ctx.addTx(a, 'credit', 100);
    await ctx.addTx(b, 'credit', 50);
  });

  const balances = async () => [await ctx.balanceOf(a), await ctx.balanceOf(b)];

  it('201 - moves money atomically (A 100->70, B 50->80)', async () => {
    const res = await ctx.api
      .post('/transfers')
      .send({ from_account_id: a, to_account_id: b, amount: 30, reference_id: 'tr-1', description: 'Rent' });
    expect(res.status).toBe(201);
    expect(res.body.transfer).toMatchObject({ from_account_id: a, to_account_id: b, amount: 30 });
    expect(res.body.balances).toEqual({ [a]: 70, [b]: 80 });
    expect(await balances()).toEqual([70, 80]);

    // Both legs appear in each account's history, linked by transfer_id.
    const hist = await ctx.api.get(`/accounts/${b}/transactions?type=credit`);
    expect(hist.body.data[0]).toMatchObject({ amount: 30, transfer_id: res.body.transfer.id });
  });

  it('422 - insufficient balance; no partial transfer', async () => {
    const res = await ctx.api.post('/transfers').send({ from_account_id: a, to_account_id: b, amount: 500, reference_id: 'x' });
    expect(res.status).toBe(422);
    expectErrorShape(res.body, 'INSUFFICIENT_BALANCE');
    expect(await balances()).toEqual([100, 50]);
  });

  it('404 - destination missing; source not debited', async () => {
    const res = await ctx.api
      .post('/transfers')
      .send({ from_account_id: a, to_account_id: '00000000-0000-4000-8000-000000000000', amount: 10, reference_id: 'x' });
    expect(res.status).toBe(404);
    expectErrorShape(res.body, 'ACCOUNT_NOT_FOUND');
    expect(await balances()).toEqual([100, 50]);
  });

  it('409 - duplicate transfer reference', async () => {
    const body = { from_account_id: a, to_account_id: b, amount: 10, reference_id: 'tr-dup' };
    expect((await ctx.api.post('/transfers').send(body)).status).toBe(201);
    const dup = await ctx.api.post('/transfers').send(body);
    expect(dup.status).toBe(409);
    expectErrorShape(dup.body, 'DUPLICATE_TRANSACTION');
    expect(await balances()).toEqual([90, 60]);
  });

  it.each([
    ['same account', (x: string) => ({ from_account_id: x, to_account_id: x, amount: 10, reference_id: 'r' })],
    ['zero amount', (x: string, y: string) => ({ from_account_id: x, to_account_id: y, amount: 0, reference_id: 'r' })],
    ['missing reference', (x: string, y: string) => ({ from_account_id: x, to_account_id: y, amount: 10 })],
    ['malformed to_account_id', (x: string) => ({ from_account_id: x, to_account_id: 'alice-account', amount: 10, reference_id: 'r' })],
    ['malformed from_account_id', (_x: string, y: string) => ({ from_account_id: 'nope', to_account_id: y, amount: 10, reference_id: 'r' })],
  ])('400 - %s', async (_label, build) => {
    const res = await ctx.api.post('/transfers').send(build(a, b));
    expect(res.status).toBe(400);
    expectErrorShape(res.body, 'VALIDATION_ERROR');
    expect(await balances()).toEqual([100, 50]);
  });
});
