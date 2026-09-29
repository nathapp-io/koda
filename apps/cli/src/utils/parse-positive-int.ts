import { InvalidArgumentError } from 'commander';

/**
 * Commander option parser for counts, sizes and ids: a whole number >= 1.
 * Anything else (NaN, 0, negatives, decimals, exponents, trailing junk, values
 * beyond Number.MAX_SAFE_INTEGER) fails before any request is sent, and
 * commander exits 1 with the option name in the message.
 */
export function parsePositiveInt(value: string): number {
  const trimmed = value.trim();
  const parsed = Number(trimmed);
  if (!/^\d+$/.test(trimmed) || !Number.isSafeInteger(parsed) || parsed < 1) {
    throw new InvalidArgumentError('must be a positive integer');
  }
  return parsed;
}
