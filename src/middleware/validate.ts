import { ZodType } from 'zod';
import { validationError } from './errorHandler';

/** Parses input with the schema, throwing a consistent 400 AppError on failure. */
export function parse<T>(schema: ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) throw validationError(result.error);
  return result.data;
}
