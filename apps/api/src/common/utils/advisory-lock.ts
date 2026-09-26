import type { PrismaClient } from '@prisma/client';

/**
 * Transaction-scoped Postgres advisory locks (two-int form).
 *
 * Call only inside txManager.run: pg_advisory_xact_lock is released at
 * COMMIT/ROLLBACK, so outside a transaction it would release immediately.
 * The lock serializes a check-then-write (e.g. "is this the last admin?")
 * that a unique index cannot express.
 */
export const KODA_LOCK_CLASS = { GLOBAL: 72400, PROJECT_MEMBERS: 72401 } as const;

export const GlobalLock = { USER_BOOTSTRAP: 1, USER_ADMINISTRATION: 2 } as const;
export type GlobalLockKey = (typeof GlobalLock)[keyof typeof GlobalLock];

type RawQueryClient = Pick<PrismaClient, '$queryRaw'>;

// The lock function returns `void`, which Prisma cannot deserialize, so it
// runs in a subquery and the statement returns a constant instead.
export async function lockGlobal(db: RawQueryClient, key: GlobalLockKey): Promise<void> {
  await db.$queryRaw`SELECT 1 AS locked FROM (SELECT pg_advisory_xact_lock(${KODA_LOCK_CLASS.GLOBAL}::int4, ${key}::int4)) AS l`;
}

export async function lockProjectMembers(db: RawQueryClient, projectId: string): Promise<void> {
  await db.$queryRaw`SELECT 1 AS locked FROM (SELECT pg_advisory_xact_lock(${KODA_LOCK_CLASS.PROJECT_MEMBERS}::int4, hashtext(${projectId}))) AS l`;
}
