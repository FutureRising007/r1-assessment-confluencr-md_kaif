import {
  createAccountSchema,
  createTransactionSchema,
  historyQuerySchema,
  transferSchema,
} from '../../src/validation/schemas';

describe('createAccountSchema', () => {
  it('accepts a valid name and trims it', () => {
    expect(createAccountSchema.parse({ name: '  Alice  ' })).toEqual({ name: 'Alice' });
  });

  it.each([{}, { name: '' }, { name: '   ' }, { name: 42 }, { name: null }])(
    'rejects invalid name: %j',
    (body) => {
      expect(createAccountSchema.safeParse(body).success).toBe(false);
    },
  );

  it.each(['balance', 'id', 'created_at'])('rejects client-supplied system field "%s"', (field) => {
    expect(createAccountSchema.safeParse({ name: 'Alice', [field]: 500 }).success).toBe(false);
  });
});

describe('createTransactionSchema', () => {
  const valid = { type: 'credit', amount: 50, description: 'Salary', reference_id: 'ref-1' };

  it('accepts a valid transaction', () => {
    expect(createTransactionSchema.parse(valid)).toMatchObject(valid);
  });

  it('description is optional', () => {
    const { description, ...rest } = valid;
    expect(createTransactionSchema.safeParse(rest).success).toBe(true);
  });

  it.each([
    ['invalid type', { type: 'refund' }],
    ['zero amount', { amount: 0 }],
    ['negative amount', { amount: -5 }],
    ['string amount', { amount: '50' }],
    ['more than 2 decimals', { amount: 10.123 }],
    ['non-finite amount', { amount: Infinity }],
    ['missing reference_id', { reference_id: undefined }],
    ['blank reference_id', { reference_id: '  ' }],
  ])('rejects %s', (_label, override) => {
    expect(createTransactionSchema.safeParse({ ...valid, ...override }).success).toBe(false);
  });
});

describe('historyQuerySchema', () => {
  it('applies defaults', () => {
    expect(historyQuerySchema.parse({})).toEqual({ page: 1, limit: 10 });
  });

  it('coerces numeric strings and accepts a type filter', () => {
    expect(historyQuerySchema.parse({ page: '2', limit: '5', type: 'debit' })).toEqual({
      page: 2,
      limit: 5,
      type: 'debit',
    });
  });

  it.each([
    { page: '0' },
    { page: '-1' },
    { page: 'abc' },
    { page: '1.5' },
    { limit: '0' },
    { limit: '101' },
    { type: 'refund' },
  ])('rejects %j', (query) => {
    expect(historyQuerySchema.safeParse(query).success).toBe(false);
  });
});

describe('transferSchema', () => {
  const A = '6f1c2a3b-1d2e-4f50-8a9b-0c1d2e3f4a5b';
  const B = '7a2d3b4c-2e3f-4a61-9b0c-1d2e3f4a5b6c';
  const valid = { from_account_id: A, to_account_id: B, amount: 30, reference_id: 't-1' };

  it('accepts a valid transfer', () => {
    expect(transferSchema.safeParse(valid).success).toBe(true);
  });

  it('rejects transfer to the same account', () => {
    expect(transferSchema.safeParse({ ...valid, to_account_id: A }).success).toBe(false);
  });

  it.each(['from_account_id', 'to_account_id'])('rejects a non-UUID %s', (field) => {
    const result = transferSchema.safeParse({ ...valid, [field]: 'alice-account' });
    expect(result.success).toBe(false);
    expect(result.error!.issues[0].path).toEqual([field]);
  });

  it('rejects non-positive amount', () => {
    expect(transferSchema.safeParse({ ...valid, amount: 0 }).success).toBe(false);
  });
});
