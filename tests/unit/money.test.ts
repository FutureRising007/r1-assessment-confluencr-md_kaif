import { toMinor, fromMinor } from '../../src/utils/money';

describe('money utils', () => {
  it('converts major units to integer minor units', () => {
    expect(toMinor(100)).toBe(10000);
    expect(toMinor(0.1)).toBe(10);
    expect(toMinor(19.99)).toBe(1999);
  });

  it('avoids floating point drift (0.1 + 0.2 style inputs)', () => {
    expect(toMinor(0.1 + 0.2)).toBe(30);
    expect(toMinor(1.15)).toBe(115);
  });

  it('converts minor units back to major units', () => {
    expect(fromMinor(10000)).toBe(100);
    expect(fromMinor(1999)).toBe(19.99);
    expect(fromMinor(0)).toBe(0);
  });
});
