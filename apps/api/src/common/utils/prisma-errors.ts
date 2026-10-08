import { getUniqueConstraintTarget } from '@nathapp/nestjs-prisma';
import { Prisma } from '../../generated/prisma/client';

/**
 * True for a Postgres unique violation (P2002) on an index covering `field`. Prisma 7 driver
 * adapters name the violated index (`User_email_key`) instead of setting `meta.target`; Prisma's
 * default index names contain every column, so one substring test covers both shapes.
 */
export function isUniqueViolation(error: unknown, field: string): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') {
    return false;
  }
  const target = getUniqueConstraintTarget(error);
  if (Array.isArray(target)) return target.includes(field);
  if (typeof target === 'string') return target.includes(field);
  return false;
}
