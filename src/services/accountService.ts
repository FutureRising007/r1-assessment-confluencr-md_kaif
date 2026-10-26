import { randomUUID } from 'crypto';
import { DB, Executor } from '../db';
import { accountNotFound } from '../errors';
import { fromMinor } from '../utils/money';
import { UUID_RE } from '../validation/schemas';

export interface AccountRow {
  id: string;
  name: string;
  balance_minor: number;
  created_at: Date;
}

export interface Account {
  id: string;
  name: string;
  balance: number;
  created_at: string;
}

const toAccount = (row: AccountRow): Account => ({
  id: row.id,
  name: row.name,
  balance: fromMinor(row.balance_minor),
  created_at: row.created_at.toISOString(),
});

export class AccountService {
  constructor(private readonly db: DB) {}

  async create(name: string): Promise<Account> {
    // balance and created_at are never taken from input; the DB defaults apply (0, now).
    const { rows } = await this.db.query<AccountRow>(
      'INSERT INTO accounts (id, name) VALUES ($1, $2) RETURNING *',
      [randomUUID(), name],
    );
    return toAccount(rows[0]);
  }

  /**
   * Loads the account row. With forUpdate, takes a row lock that is held until
   * the surrounding transaction ends - this serialises concurrent writers.
   */
  async getRow(id: string, executor: Executor = this.db, forUpdate = false): Promise<AccountRow> {
    // A malformed id can't exist; short-circuit instead of letting Postgres raise a cast error.
    if (!UUID_RE.test(id)) throw accountNotFound(id);
    const { rows } = await executor.query<AccountRow>(
      `SELECT * FROM accounts WHERE id = $1${forUpdate ? ' FOR UPDATE' : ''}`,
      [id],
    );
    if (!rows[0]) throw accountNotFound(id);
    return rows[0];
  }

  async get(id: string): Promise<Account> {
    return toAccount(await this.getRow(id));
  }

  async getBalance(id: string, executor: Executor = this.db): Promise<{ account_id: string; balance: number }> {
    const row = await this.getRow(id, executor);
    return { account_id: row.id, balance: fromMinor(row.balance_minor) };
  }
}
