import { AccountService } from '../../../src/services/accountService';
import { AppError } from '../../../src/errors';
import { useTestDb, catchErr } from '../../setup/testDb';

describe('AccountService (PostgreSQL)', () => {
  const db = useTestDb();
  let accounts: AccountService;

  beforeEach(() => {
    accounts = new AccountService(db());
  });

  it('creates an account with zero balance and system-generated id/created_at', async () => {
    const acc = await accounts.create('Alice');
    expect(acc).toEqual({
      id: expect.stringMatching(/^[0-9a-f-]{36}$/),
      name: 'Alice',
      balance: 0,
      created_at: expect.any(String),
    });
    expect(new Date(acc.created_at).toISOString()).toBe(acc.created_at);
  });

  it('generates unique ids', async () => {
    const created = await Promise.all(Array.from({ length: 20 }, () => accounts.create('X')));
    expect(new Set(created.map((a) => a.id)).size).toBe(20);
  });

  it('fetches an existing account', async () => {
    const acc = await accounts.create('Bob');
    expect(await accounts.get(acc.id)).toEqual(acc);
  });

  it.each(['nope', '00000000-0000-0000-0000-000000000000'])('throws 404 ACCOUNT_NOT_FOUND for "%s"', async (id) => {
    const err = await catchErr<AppError>(accounts.get(id));
    expect(err).toBeInstanceOf(AppError);
    expect(err.code).toBe('ACCOUNT_NOT_FOUND');
    expect(err.status).toBe(404);
  });

  it('returns balance in { account_id, balance } shape', async () => {
    const acc = await accounts.create('Carol');
    expect(await accounts.getBalance(acc.id)).toEqual({ account_id: acc.id, balance: 0 });
  });

  it('database rejects a negative balance even if app logic were bypassed', async () => {
    const acc = await accounts.create('Dave');
    await expect(db().query('UPDATE accounts SET balance_minor = -1 WHERE id = $1', [acc.id])).rejects.toThrow(
      /check constraint/,
    );
  });
});
