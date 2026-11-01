const COST = /^(\d+)(?:\.(\d{1,4}))?$/;
const SCALE = 10_000;

function parseTenThousandths(value: string): number | null {
  const match = COST.exec(value);
  if (!match) return null;
  const whole = Number(match[1]);
  const fraction = Number((match[2] ?? '').padEnd(4, '0'));
  const amount = whole * SCALE + fraction;
  return Number.isSafeInteger(amount) ? amount : null;
}

/** Returns the remaining fix budget, or null when no usable positive remainder can be established. */
export function fixBudgetRemainder(maxCostUsd: string, spentUsd: string | undefined): number | null {
  if (spentUsd === undefined) return null;
  const max = parseTenThousandths(maxCostUsd);
  const spent = parseTenThousandths(spentUsd);
  if (max === null || spent === null) return null;
  const remainder = max - spent;
  return remainder > 0 ? remainder / SCALE : null;
}
