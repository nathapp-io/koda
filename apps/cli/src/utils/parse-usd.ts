import { InvalidArgumentError } from 'commander';

function parseUsdUpTo(value: string, max: number): number {
  const trimmed = value.trim();
  if (!/^\d+(\.\d{1,4})?$/.test(trimmed)) {
    throw new InvalidArgumentError('must be a USD amount with at most 4 decimals, for example 5 or 0.25');
  }
  const parsed = Number(trimmed);
  if (parsed <= 0 || parsed > max) throw new InvalidArgumentError(`must be more than 0 and at most ${max}`);
  return parsed;
}

/**
 * Commander parser for a USD budget: > 0, at most 10000, at most 4 decimals (DispatchFleetJobDto.maxCostUsd).
 * Plain decimal notation only: no exponent, sign or hex, so what the user typed is what is sent.
 */
export function parseUsd(value: string): number {
  return parseUsdUpTo(value, 10_000);
}

/** Same format as parseUsd, up to 1,000,000: a budget policy amount (plan D169). */
export function parseBudgetUsd(value: string): number {
  return parseUsdUpTo(value, 1_000_000);
}
