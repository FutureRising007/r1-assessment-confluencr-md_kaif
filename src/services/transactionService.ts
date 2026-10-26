import { randomUUID } from 'crypto';
import { PoolClient } from 'pg';
import { DB, withTransaction } from '../db';
import { AppError, balanceLimitExceeded, insufficientBalance } from '../errors';
import { fromMinor, toMinor } from '../utils/money';
import { CreateTransactionInput, HistoryQuery } from '../validation/schemas';
import { AccountService } from './accountService';

export type TransactionType = 'credit' | 'debit';

interface TransactionRow {
  id: string;
  account_id: string;
  type: TransactionType;
  amount_minor: number;
  description: string | null;
  reference_id: string;
  transfer_id: string | null;
  created_at: Date;
}

export interface Transaction {
  id: string;
  account_id: string;
  type: TransactionType;
  amount: number;
  description: string | null;
  reference_id: string;
  transfer_id: string | null;
  created_at: string;
}

export interface LedgerEntry {
  accountId: string;
  type: TransactionType;
  amountMinor: number;
  description?: string | null;
  referenceId: string;
  transferId?: string | null;
}

export interface Paginated<T> {
  data: T[];
  pagination: { page: number; limit: number; total_records: number; total_pages: number };
}

const COLUMNS = 'id, account_id, type, amount_minor, description, reference_id, transfer_id, created_at';

const toTransaction = (row: TransactionRow): Transaction => ({
  id: row.id,
  account_id: row.account_id,
  type: row.type,
  amount: fromMinor(row.amount_minor),
  description: row.description,
  reference_id: row.reference_id,
  transfer_id: row.transfer_id,
  created_at: row.created_at.toISOString(),
});

const UNIQUE_REFERENCE = 'transactions_account_reference_unique';

const isDuplicateReference = (e: unknown) =>
  typeof e === 'object' &&
  e !== null &&
  (e as { code?: string }).code === '23505' &&
  (e as { constraint?: string }).constraint === UNIQUE_REFERENCE;

export class TransactionService {
  constructor(
    private readonly db: DB,
    private readonly accounts: AccountService,
  ) {}

  /** Records a credit/debit and updates the balance as one atomic unit. */
  async create(accountId: string, input: CreateTransactionInput): Promise<{ transaction: Transaction; balance: number }> {
    return this.withDuplicateHandling(accountId, input.reference_id, () =>
      withTransaction(this.db, async (client) => {
        await this.accounts.getRow(accountId, client, true); // row lock
        const transaction = await this.applyEntry(client, {
          accountId,
          type: input.type,
          amountMinor: toMinor(input.amount),
          description: input.description ?? null,
          referenceId: input.reference_id,
        });
        const { balance } = await this.accounts.getBalance(accountId, client);
        return { transaction, balance };
      }),
    );
  }

  /**
   * Inserts one ledger entry and moves the balance. Must run inside a transaction
   * that already holds the account's row lock (see create / TransferService).
   */
  async applyEntry(client: PoolClient, entry: LedgerEntry): Promise<Transaction> {
    const account = await this.accounts.getRow(entry.accountId, client);

    const existing = await this.findByReference(client, entry.accountId, entry.referenceId);
    if (existing) throw this.duplicate(existing);

    if (entry.type === 'debit' && account.balance_minor < entry.amountMinor) {
      throw insufficientBalance(account.id, fromMinor(account.balance_minor), fromMinor(entry.amountMinor));
    }
    if (entry.type === 'credit' && account.balance_minor + entry.amountMinor > Number.MAX_SAFE_INTEGER) {
      throw balanceLimitExceeded(account.id);
    }

    const { rows } = await client.query<TransactionRow>(
      `INSERT INTO transactions (id, account_id, type, amount_minor, description, reference_id, transfer_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING ${COLUMNS}`,
      [
        randomUUID(),
        entry.accountId,
        entry.type,
        entry.amountMinor,
        entry.description ?? null,
        entry.referenceId,
        entry.transferId ?? null,
      ],
    );

    const delta = entry.type === 'credit' ? entry.amountMinor : -entry.amountMinor;
    // Guarded update: a second line of defence (with the CHECK constraint) against overdraft.
    const result = await client.query(
      'UPDATE accounts SET balance_minor = balance_minor + $1 WHERE id = $2 AND balance_minor + $1 >= 0',
      [delta, entry.accountId],
    );
    if (result.rowCount !== 1) {
      throw insufficientBalance(account.id, fromMinor(account.balance_minor), fromMinor(entry.amountMinor));
    }

    return toTransaction(rows[0]);
  }

  async list(accountId: string, query: HistoryQuery): Promise<Paginated<Transaction>> {
    await this.accounts.getRow(accountId);
    const { page, limit, type } = query;

    const params: unknown[] = [accountId];
    let where = 'account_id = $1';
    if (type) {
      params.push(type);
      where += ` AND type = $${params.length}`;
    }

    // Both queries share one REPEATABLE READ snapshot, so total_records always
    // matches the rows being paged even while new transactions are committed.
    const { total, rows } = await withTransaction(
      this.db,
      async (client) => {
        const count = await client.query<{ total: number }>(
          `SELECT COUNT(*)::int AS total FROM transactions WHERE ${where}`,
          params,
        );
        const page_ = await client.query<TransactionRow>(
          `SELECT ${COLUMNS} FROM transactions WHERE ${where}
           ORDER BY created_at DESC, seq DESC
           LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
          [...params, limit, (page - 1) * limit],
        );
        return { total: count.rows[0].total, rows: page_.rows };
      },
      'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY',
    );

    return {
      data: rows.map(toTransaction),
      pagination: { page, limit, total_records: total, total_pages: Math.ceil(total / limit) },
    };
  }

  /** Recomputes the balance from the ledger; used to verify balance consistency. */
  async computeBalanceFromLedger(accountId: string): Promise<number> {
    const { rows } = await this.db.query<{ sum: number }>(
      `SELECT COALESCE(SUM(CASE type WHEN 'credit' THEN amount_minor ELSE -amount_minor END), 0)::bigint AS sum
       FROM transactions WHERE account_id = $1`,
      [accountId],
    );
    return fromMinor(rows[0].sum);
  }

  /**
   * Safety net for a race the row lock can't see: if the UNIQUE constraint fires
   * anyway, the transaction is already rolled back - report it as a 409.
   */
  async withDuplicateHandling<T>(accountId: string, referenceId: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      if (!isDuplicateReference(e)) throw e;
      const existing = await this.findByReference(this.db, accountId, referenceId);
      if (!existing) throw e;
      throw this.duplicate(existing);
    }
  }

  private async findByReference(
    executor: DB | PoolClient,
    accountId: string,
    referenceId: string,
  ): Promise<TransactionRow | undefined> {
    const { rows } = await executor.query<TransactionRow>(
      `SELECT ${COLUMNS} FROM transactions WHERE account_id = $1 AND reference_id = $2`,
      [accountId, referenceId],
    );
    return rows[0];
  }

  private duplicate(existing: TransactionRow): AppError {
    return new AppError(
      409,
      'DUPLICATE_TRANSACTION',
      `A transaction with reference_id '${existing.reference_id}' already exists for this account`,
      { existing_transaction: toTransaction(existing) },
    );
  }
}
