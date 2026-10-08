/**
 * isUniqueViolation must recognise a real P2002 raised through the Prisma 7 pg adapter,
 * which reports the violated index name instead of meta.target.
 *
 * Run: cd apps/api && bun run test:scoped test/integration/db/unique-violation.integration.spec.ts
 */
import { createTestPrismaClient } from '../../helpers/test-prisma';
import { isUniqueViolation } from '../../../src/common/utils/prisma-errors';

const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;

describeIntegration('isUniqueViolation against a real P2002 (pg adapter)', () => {
  const email = 'unique-violation@koda.test';
  const prisma = createTestPrismaClient();

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { email } });
    await prisma.$disconnect();
  });

  it('recognises a duplicate User.email and only that field', async () => {
    await prisma.user.create({ data: { email, passwordHash: 'x' } });
    const error = await prisma.user.create({ data: { email, passwordHash: 'x' } }).catch((e: unknown) => e);
    expect(isUniqueViolation(error, 'email')).toBe(true);
    expect(isUniqueViolation(error, 'slug')).toBe(false);
  });
});
