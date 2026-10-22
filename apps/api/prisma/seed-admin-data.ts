import type { PrismaClient } from '../src/generated/prisma/client';
import * as bcrypt from 'bcrypt';
import { GlobalLock, lockGlobal } from '../src/common/utils/advisory-lock';
import { grantBaseline, grantRole } from '../src/permissions/test-helpers/permission-fixtures';

export type SeedAdminOutcome =
  | { created: true; userId: string; roleKey: 'owner' | 'admin' }
  | { created: false };

/**
 * Creates a new admin with a global member baseline and the first owner binding, or admin when an
 * owner already exists. An existing email writes nothing, including no system-role seed writes.
 * The bootstrap lock serializes seed runs; all seed writes commit or roll back together.
 */
export async function seedAdminUser(
  db: PrismaClient,
  input: { email: string; name: string; password: string },
): Promise<SeedAdminOutcome> {
  if (await db.user.findUnique({ where: { email: input.email } })) return { created: false };
  // Do expensive hashing before opening the transaction or holding the bootstrap lock.
  const passwordHash = await bcrypt.hash(input.password, 12);

  // Standalone scripts have no DI transaction manager. Pass the transaction client to the grant
  // helpers so their role seeding, bindings and admin mirror join this same transaction.
  return db.$transaction(async (tx): Promise<SeedAdminOutcome> => {
    await lockGlobal(tx, GlobalLock.USER_BOOTSTRAP);
    // Another seed may have created this email while this invocation hashed or waited for the lock.
    if (await tx.user.findUnique({ where: { email: input.email } })) return { created: false };
    const owner = await tx.roleBinding.findFirst({
      where: { projectId: null, role: { key: 'owner' } },
      select: { id: true },
    });
    const roleKey = owner ? 'admin' : 'owner';
    const user = await tx.user.create({ data: { email: input.email, name: input.name, passwordHash } });
    const principal = { type: 'USER', id: user.id } as const;
    await grantBaseline(tx, principal);
    await grantRole(tx, principal, roleKey);
    return { created: true, userId: user.id, roleKey };
  }, { isolationLevel: 'ReadCommitted' });
}
