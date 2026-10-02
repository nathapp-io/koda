import { Prisma } from '@prisma/client';

/** Exact decimal sum of two USD strings, as the 4-decimal string the Decimal(12,4) columns hold. */
export function addUsd(a: string, b: string): string {
  return new Prisma.Decimal(a).add(b).toFixed(4);
}
