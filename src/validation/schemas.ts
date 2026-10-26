import { z } from 'zod';
import { hasAtMostTwoDecimals } from '../utils/money';

const MAX_AMOUNT = 1_000_000_000; // guard against absurd values / integer overflow in minor units

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const accountId = (field: string) =>
  z.string({ error: `${field} is required and must be a string` }).trim().regex(UUID_RE, `${field} must be a valid UUID`);

const amount = z
  .number({ error: 'amount must be a number' })
  .finite('amount must be a finite number')
  .positive('amount must be greater than 0')
  .max(MAX_AMOUNT, `amount must not exceed ${MAX_AMOUNT}`)
  .refine(hasAtMostTwoDecimals, 'amount must have at most 2 decimal places');

const nonEmptyString = (field: string, max: number) =>
  z
    .string({ error: `${field} is required and must be a string` })
    .trim()
    .min(1, `${field} must not be empty`)
    .max(max, `${field} must be at most ${max} characters`);

// .strict() rejects unknown keys, so clients cannot sneak in balance / id / created_at.
export const createAccountSchema = z
  .object({ name: nonEmptyString('name', 100) })
  .strict();

export const createTransactionSchema = z
  .object({
    type: z.enum(['credit', 'debit'], { error: "type must be either 'credit' or 'debit'" }),
    amount,
    description: z.string().trim().max(255, 'description must be at most 255 characters').optional(),
    reference_id: nonEmptyString('reference_id', 100),
  })
  .strict();

const positiveIntFromQuery = (field: string, max?: number) => {
  let schema = z.coerce
    .number({ error: `${field} must be a number` })
    .int(`${field} must be an integer`)
    .min(1, `${field} must be at least 1`);
  if (max) schema = schema.max(max, `${field} must be at most ${max}`);
  return schema;
};

export const historyQuerySchema = z.object({
  page: z.preprocess((v) => (v === '' ? undefined : v), positiveIntFromQuery('page').default(1)),
  limit: z.preprocess((v) => (v === '' ? undefined : v), positiveIntFromQuery('limit', 100).default(10)),
  type: z.enum(['credit', 'debit'], { error: "type must be either 'credit' or 'debit'" }).optional(),
});

export const transferSchema = z
  .object({
    from_account_id: accountId('from_account_id'),
    to_account_id: accountId('to_account_id'),
    amount,
    description: z.string().trim().max(255).optional(),
    reference_id: nonEmptyString('reference_id', 100),
  })
  .strict()
  .refine((t) => t.from_account_id !== t.to_account_id, {
    message: 'from_account_id and to_account_id must be different',
    path: ['to_account_id'],
  });

export type CreateTransactionInput = z.infer<typeof createTransactionSchema>;
export type HistoryQuery = z.infer<typeof historyQuerySchema>;
export type TransferInput = z.infer<typeof transferSchema>;
