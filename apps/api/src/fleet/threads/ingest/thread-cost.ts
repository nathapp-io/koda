import { Prisma } from '../../../generated/prisma/client';

/** Round a monetary sum once to the thread/job display precision using decimal half-up rounding. */
export function round4(value: Prisma.Decimal): Prisma.Decimal {
  return value.toDecimalPlaces(4, Prisma.Decimal.ROUND_HALF_UP);
}
