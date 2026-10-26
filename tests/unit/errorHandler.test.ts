import { z } from 'zod';
import { AppError } from '../../src/errors';
import { errorHandler, validationError } from '../../src/middleware/errorHandler';

function mockRes() {
  const res: any = {};
  res.status = jest.fn(() => res);
  res.json = jest.fn(() => res);
  return res;
}

const run = (err: unknown) => {
  const res = mockRes();
  errorHandler(err, {} as any, res, jest.fn());
  return { status: res.status.mock.calls[0][0], body: res.json.mock.calls[0][0] };
};

describe('errorHandler', () => {
  it('renders AppError with its status, code, message and details', () => {
    const { status, body } = run(new AppError(404, 'ACCOUNT_NOT_FOUND', 'Account x not found', { account_id: 'x' }));
    expect(status).toBe(404);
    expect(body).toEqual({ error: { code: 'ACCOUNT_NOT_FOUND', message: 'Account x not found', details: { account_id: 'x' } } });
  });

  it('omits details when there are none', () => {
    expect(run(new AppError(405, 'METHOD_NOT_ALLOWED', 'nope')).body).toEqual({
      error: { code: 'METHOD_NOT_ALLOWED', message: 'nope' },
    });
  });

  it('maps body-parser JSON syntax errors to 400 INVALID_JSON', () => {
    const { status, body } = run(Object.assign(new SyntaxError('bad'), { type: 'entity.parse.failed' }));
    expect(status).toBe(400);
    expect(body.error.code).toBe('INVALID_JSON');
  });

  it('hides internals of unexpected errors behind a 500', () => {
    const spy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const { status, body } = run(new Error('connection string with password leaked'));
    expect(status).toBe(500);
    expect(body).toEqual({ error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred' } });
    spy.mockRestore();
  });
});

describe('validationError', () => {
  it('converts zod issues into field-level details', () => {
    const result = z.object({ name: z.string(), amount: z.number() }).safeParse({ amount: 'x' });
    const err = validationError(result.error!);
    expect(err.status).toBe(400);
    expect(err.code).toBe('VALIDATION_ERROR');
    expect((err.details as any[]).map((d) => d.field).sort()).toEqual(['amount', 'name']);
  });

  it('can be tagged as INVALID_PAGINATION', () => {
    const result = z.object({ page: z.number() }).safeParse({});
    expect(validationError(result.error!, 'INVALID_PAGINATION').code).toBe('INVALID_PAGINATION');
  });
});
