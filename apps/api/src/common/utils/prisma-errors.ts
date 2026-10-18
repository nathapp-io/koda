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

/**
 * True for `P2025` — the record a statement targeted no longer exists (a concurrent delete).
 */
export function isRecordNotFound(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025';
}

/**
 * True for a Postgres foreign-key violation (P2003) naming `field`. Driver adapters may report the
 * constraint without a name at all (`driverAdapterError.cause.kind = ForeignKeyConstraintViolation`);
 * a nameless P2003 counts as a match, because the caller is asking about the only relation its
 * statement can violate (a role delete is refused only by `RoleBinding.roleId`).
 */
export function isForeignKeyViolation(error: unknown, field: string): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2003') {
    return false;
  }
  const meta = error.meta as Record<string, unknown> | undefined;
  const constraint = meta?.['field_name'] ?? meta?.['constraint'] ?? constraintOf(meta);
  if (typeof constraint === 'string') return constraint.includes(field);
  return true;
}

function constraintOf(meta: Record<string, unknown> | undefined): string | undefined {
  const adapter = meta?.['driverAdapterError'] as
    | { cause?: { constraint?: { index?: unknown } | string } }
    | undefined;
  const constraint = adapter?.cause?.constraint;
  if (typeof constraint === 'string') return constraint;
  return typeof constraint?.index === 'string' ? constraint.index : undefined;
}

