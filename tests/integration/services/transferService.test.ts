import { AccountService } from '../../../src/services/accountService';
import { TransactionService } from '../../../src/services/transactionService';
import { TransferService } from '../../../src/services/transferService';
import { AppError } from '../../../src/errors';
import { useTestDb, catchErr } from '../../setup/testDb';

describe('TransferService (PostgreSQL)', () => {
  const db = useTestDb();
  let accounts: AccountService;
  let txs: TransactionService;
  let transfers: TransferService;
  let a: string;
  let b: string;

  beforeEach(async () => {
    accounts = new AccountService(db());
    txs = new TransactionService(db(), accounts);
    transfers = new TransferService(db(), accounts, txs);
    a = (await accounts.create('A')).id;
    b = (await accounts.create('B')).id;
    await txs.create(a, { type: 'credit', amount: 100, reference_id: 'seed-a' });
    await txs.create(b, { type: 'credit', amount: 50, reference_id: 'seed-b' });
  });

  const bal = async (id: string) => (await accounts.getBalance(id)).balance;
  const count = async (id: string) => (await txs.list(id, { page: 1, limit: 100 })).pagination.total_records;
  const snapshot = async () => [await bal(a), await bal(b), await count(a), await count(b)];
  const transferCount = async () => (await db().query('SELECT COUNT(*)::int AS c FROM transfers')).rows[0].c;

  it('spec example: A=100, B=50, transfer 30 A->B => A=70, B=80', async () => {
    const result = await transfers.transfer({ from_account_id: a, to_account_id: b, amount: 30, reference_id: 't1' });
    expect(await bal(a)).toBe(70);
    expect(await bal(b)).toBe(80);
    expect(result.transfer).toMatchObject({ from_account_id: a, to_account_id: b, amount: 30, reference_id: 't1' });
    expect(result.debit).toMatchObject({ account_id: a, type: 'debit', amount: 30, transfer_id: result.transfer.id });
    expect(result.credit).toMatchObject({ account_id: b, type: 'credit', amount: 30, transfer_id: result.transfer.id });
    expect(result.balances).toEqual({ [a]: 70, [b]: 80 });
  });

  it('rejects when source has insufficient balance; nothing changes', async () => {
    const err = await catchErr<AppError>(
      transfers.transfer({ from_account_id: a, to_account_id: b, amount: 101, reference_id: 't1' }),
    );
    expect(err.code).toBe('INSUFFICIENT_BALANCE');
    expect(await snapshot()).toEqual([100, 50, 1, 1]);
    expect(await transferCount()).toBe(0);
  });

  it.each(['from', 'to'] as const)('404 when %s account does not exist; nothing changes', async (side) => {
    const input = { from_account_id: a, to_account_id: b, amount: 10, reference_id: 't1' };
    input[`${side}_account_id`] = '00000000-0000-0000-0000-000000000000';
    expect((await catchErr<AppError>(transfers.transfer(input))).code).toBe('ACCOUNT_NOT_FOUND');
    expect(await snapshot()).toEqual([100, 50, 1, 1]);
  });

  it('rejects a duplicate reference_id; no double transfer', async () => {
    await transfers.transfer({ from_account_id: a, to_account_id: b, amount: 10, reference_id: 't1' });
    const err = await catchErr<AppError>(
      transfers.transfer({ from_account_id: a, to_account_id: b, amount: 10, reference_id: 't1' }),
    );
    expect(err.code).toBe('DUPLICATE_TRANSACTION');
    expect([await bal(a), await bal(b)]).toEqual([90, 60]);
  });

  it('rolls back the debit if the credit leg fails (no partial transfer)', async () => {
    // Inject a DB fault on the credit leg only - it fails AFTER the debit leg has been written.
    await db().query(`
      CREATE OR REPLACE FUNCTION test_fail_credit() RETURNS trigger AS $$
      BEGIN
        IF NEW.type = 'credit' AND NEW.transfer_id IS NOT NULL THEN RAISE EXCEPTION 'credit leg boom'; END IF;
        RETURN NEW;
      END; $$ LANGUAGE plpgsql;
      CREATE TRIGGER test_fail_credit BEFORE INSERT ON transactions FOR EACH ROW EXECUTE FUNCTION test_fail_credit();`);
    try {
      await expect(
        transfers.transfer({ from_account_id: a, to_account_id: b, amount: 10, reference_id: 't1' }),
      ).rejects.toThrow(/credit leg boom/);
    } finally {
      await db().query('DROP TRIGGER test_fail_credit ON transactions; DROP FUNCTION test_fail_credit();');
    }
    expect(await snapshot()).toEqual([100, 50, 1, 1]);
    expect(await transferCount()).toBe(0);
  });

  it("a reference already used on the destination does not block the transfer", async () => {
    // reference_id is unique per account: the sender's reference must not collide with the receiver's history.
    await txs.create(b, { type: 'credit', amount: 1, reference_id: 'INV-1001' });
    await transfers.transfer({ from_account_id: a, to_account_id: b, amount: 10, reference_id: 'INV-1001' });
    expect([await bal(a), await bal(b)]).toEqual([90, 61]);
  });

  it("duplicate transfer error only ever exposes the sender's own transaction", async () => {
    await txs.create(b, { type: 'credit', amount: 1, description: 'private to B', reference_id: 'r-x' });
    await transfers.transfer({ from_account_id: a, to_account_id: b, amount: 10, reference_id: 'r-x' });
    const err = await catchErr<AppError>(
      transfers.transfer({ from_account_id: a, to_account_id: b, amount: 10, reference_id: 'r-x' }),
    );
    expect(err.code).toBe('DUPLICATE_TRANSACTION');
    expect((err.details as any).existing_transaction.account_id).toBe(a);
    expect(JSON.stringify(err.details)).not.toContain('private to B');
  });

  it('opposite-direction concurrent transfers do not deadlock and conserve money', async () => {
    const ops = Array.from({ length: 30 }, (_, i) =>
      i % 2 === 0
        ? transfers.transfer({ from_account_id: a, to_account_id: b, amount: 3, reference_id: `ab-${i}` })
        : transfers.transfer({ from_account_id: b, to_account_id: a, amount: 2, reference_id: `ba-${i}` }),
    );
    const results = await Promise.allSettled(ops);
    const failures = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(failures.every((f) => f.reason.code === 'INSUFFICIENT_BALANCE')).toBe(true);
    expect((await bal(a)) + (await bal(b))).toBe(150);
    expect(await txs.computeBalanceFromLedger(a)).toBe(await bal(a));
    expect(await txs.computeBalanceFromLedger(b)).toBe(await bal(b));
  });
});
