// Amounts travel over the API in major units (e.g. 19.99) but are stored as
// integer minor units (1999) so arithmetic on balances is exact.

export const MINOR_PER_MAJOR = 100;

export function toMinor(amount: number): number {
  return Math.round(amount * MINOR_PER_MAJOR);
}

export function fromMinor(minor: number): number {
  return minor / MINOR_PER_MAJOR;
}

/** True when the number has at most 2 decimal places (tolerant to float representation). */
export function hasAtMostTwoDecimals(amount: number): boolean {
  return Math.abs(amount * MINOR_PER_MAJOR - Math.round(amount * MINOR_PER_MAJOR)) < 1e-6;
}
