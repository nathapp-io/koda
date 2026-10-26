import { randomUUID } from 'node:crypto';
import type { Prisma, PrismaClient } from '../../generated/prisma/client';
import { expandEntries } from '../../permissions/entry-matcher';
import type { PrincipalRef } from '../../permissions/permissions.types';

/** Grants precisely these entries, without the extra permissions of a seeded role. */
export async function grantKeys(
  db: PrismaClient | Prisma.TransactionClient,
  principal: PrincipalRef,
  entries: string[],
  projectId: string | null,
): Promise<{ id: string }> {
  const scope = projectId === null ? 'GLOBAL' : 'PROJECT';
  expandEntries(entries, scope);
  const role = await db.role.create({ data: {
    key: `test-${randomUUID()}`, name: 'Approval test grant', description: '', scope,
    system: false, locked: false, permissions: entries,
  } });
  return db.roleBinding.create({ data: {
    principalType: principal.type, principalId: principal.id, roleId: role.id, projectId,
    grantedByType: 'SYSTEM', grantedById: 'test',
  }, select: { id: true } });
}
