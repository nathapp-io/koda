import type { PrismaClient } from '../../src/generated/prisma/client';
import { grantBaseline } from '../../src/permissions/test-helpers/permission-fixtures';
import { loginToken, TEST_PASSWORD_HASH } from './http-app';

/**
 * A fresh member for tests of other features. User creation/audit tests use the real API instead.
 * Reuse only the immutable password hash; each call inserts a user, grants its baseline and logs
 * in through the real endpoint. Even the first fixture user receives no owner/admin privileges.
 */
export async function createMemberWithToken(
  server: Parameters<typeof loginToken>[0],
  prisma: PrismaClient,
  input: { email: string; name: string },
): Promise<{ id: string; token: string }> {
  const user = await prisma.user.create({ data: { ...input, passwordHash: TEST_PASSWORD_HASH } });
  await grantBaseline(prisma, { type: 'USER', id: user.id });
  return { id: user.id, token: await loginToken(server, input.email) };
}
