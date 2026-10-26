export type ErrorCode =
  | 'VALIDATION_ERROR'
  | 'INVALID_JSON'
  | 'INVALID_PAGINATION'
  | 'ACCOUNT_NOT_FOUND'
  | 'INSUFFICIENT_BALANCE'
  | 'BALANCE_LIMIT_EXCEEDED'
  | 'DUPLICATE_TRANSACTION'
  | 'METHOD_NOT_ALLOWED'
  | 'NOT_FOUND'
  | 'INTERNAL_ERROR';

export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: ErrorCode,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const accountNotFound = (id: string) =>
  new AppError(404, 'ACCOUNT_NOT_FOUND', `Account '${id}' not found`, { account_id: id });

export const balanceLimitExceeded = (accountId: string) =>
  new AppError(422, 'BALANCE_LIMIT_EXCEEDED', 'This credit would exceed the maximum supported account balance', {
    account_id: accountId,
  });

export const insufficientBalance =(accountId: string, balance: number, requested: number) =>
  new AppError(422, 'INSUFFICIENT_BALANCE', 'Insufficient balance for this debit', {
    account_id: accountId,
    balance,
    requested_amount: requested,
  });
