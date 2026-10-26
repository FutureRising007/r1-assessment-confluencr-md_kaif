import { ErrorRequestHandler, RequestHandler } from 'express';
import { ZodError } from 'zod';
import { AppError } from '../errors';

/** Converts a ZodError into a 400 with field-level details. */
export function validationError(err: ZodError, code: 'VALIDATION_ERROR' | 'INVALID_PAGINATION' = 'VALIDATION_ERROR') {
  const details = err.issues.map((i) => ({
    field: i.path.length ? i.path.join('.') : i.code === 'unrecognized_keys' ? (i as any).keys.join(',') : '(body)',
    message: i.message,
  }));
  return new AppError(400, code, code === 'INVALID_PAGINATION' ? 'Invalid pagination parameters' : 'Invalid request data', details);
}

export const notFoundHandler: RequestHandler = (req, _res, next) => {
  next(new AppError(404, 'NOT_FOUND', `Route ${req.method} ${req.path} not found`));
};

export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  let appErr: AppError;

  if (err instanceof AppError) {
    appErr = err;
  } else if (err?.type === 'entity.parse.failed') {
    appErr = new AppError(400, 'INVALID_JSON', 'Request body is not valid JSON');
  } else {
    console.error(err);
    appErr = new AppError(500, 'INTERNAL_ERROR', 'An unexpected error occurred');
  }

  res.status(appErr.status).json({
    error: {
      code: appErr.code,
      message: appErr.message,
      ...(appErr.details !== undefined && { details: appErr.details }),
    },
  });
};
