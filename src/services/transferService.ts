import { randomUUID } from 'crypto';
import { DB, withTransaction } from '../db';
import { fromMinor, toMinor } from '../utils/money';
import { TransferInput } from '../validation/schemas';
import { AccountService } from './accountService';
import { Transaction, TransactionService } from './transactionService';

interface TransferRow {
  id: string;
  from_account_id: string;
  to_account_id: string;
  amount_minor: number;
  description: string | null;
  reference_id: string;
  created_at: Date;
}

export interface Transfer {
  id: string;
  from_account_id: string;
  to_account_id: string;
  amount: number;
  description: string | null;
  reference_id: string;
  created_at: string;
}

export interface TransferResult {
  transfer: Transfer;
  debit: Transaction;
  credit: Transaction;
  balances: Record<string, number>;
}

const toTransfer = (row: TransferRow): Transfer => ({
  id: row.id,
  from_account_id: row.from_account_id,
  to_account_id: row.to_account_id,
  amount: fromMinor(row.amount_minor),
  description: row.description,
  reference_id: row.reference_id,
  created_at: row.created_at.toISOString(),
});

export class TransferService {
  constructor(
    private readonly db: DB,
    private readonly accounts: AccountService,
    private readonly transactions: TransactionService,
  ) {}

  /**
   * Debits the source and credits the destination in ONE database transaction.
   * Each leg is a normal ledger entry linked by transfer_id. The caller's reference_id
   * belongs to the sender's account (it makes the transfer idempotent); the credit leg
   * gets a system reference derived from the transfer id, so the receiver's own
   * reference history can neither block a transfer nor be revealed by one.
   */
  async transfer(input: TransferInput): Promise<TransferResult> {
    const amountMinor = toMinor(input.amount);

    const run = () =>
      withTransaction(this.db, async (client) => {
        // Lock both rows in a fixed (sorted) order so two opposite transfers
        // (A->B and B->A) can never deadlock waiting on each other.
        for (const id of [input.from_account_id, input.to_account_id].sort()) {
          await this.accounts.getRow(id, client, true);
        }

        const { rows } = await client.query<TransferRow>(
          `INSERT INTO transfers (id, from_account_id, to_account_id, amount_minor, description, reference_id)
           VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
          [randomUUID(), input.from_account_id, input.to_account_id, amountMinor, input.description ?? null, input.reference_id],
        );
        const transfer = toTransfer(rows[0]);

        const description = input.description ?? null;
        const debit = await this.transactions.applyEntry(client, {
          amountMinor,
          transferId: transfer.id,
          referenceId: input.reference_id,
          accountId: input.from_account_id,
          type: 'debit',
          description: description ?? `Transfer to ${input.to_account_id}`,
        });
        const credit = await this.transactions.applyEntry(client, {
          amountMinor,
          transferId: transfer.id,
          referenceId: `transfer:${transfer.id}`,
          accountId: input.to_account_id,
          type: 'credit',
          description: description ?? `Transfer from ${input.from_account_id}`,
        });

        const balances: Record<string, number> = {};
        for (const id of [input.from_account_id, input.to_account_id]) {
          balances[id] = (await this.accounts.getBalance(id, client)).balance;
        }
        return { transfer, debit, credit, balances };
      });

    // A UNIQUE-constraint race on the sender's reference surfaces as a 409, never a 500.
    return this.transactions.withDuplicateHandling(input.from_account_id, input.reference_id, run);
  }
}
