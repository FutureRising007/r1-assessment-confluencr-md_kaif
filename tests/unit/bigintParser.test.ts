import { parseBigint } from '../../src/db';

describe('parseBigint (PostgreSQL BIGINT -> JS number)', () => {
  it('converts safe integers exactly', () => {
    expect(parseBigint('0')).toBe(0);
    expect(parseBigint('123456789')).toBe(123456789);
    expect(parseBigint(String(Number.MAX_SAFE_INTEGER))).toBe(Number.MAX_SAFE_INTEGER);
  });

  it('throws instead of silently rounding values beyond 2^53 - 1', () => {
    expect(() => parseBigint('9007199254740992')).toThrow(/precision/);
    expect(() => parseBigint('-9007199254740992')).toThrow(/precision/);
  });
});
