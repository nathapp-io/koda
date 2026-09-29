/**
 * #162 — spent enrollment rows are purged by the two date columns (PG).
 * Run: cd apps/api && bun run test:scoped test/integration/fleet/enrollment-retention.integration.spec.ts
 */
import { PrismaClient } from '@prisma/client';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { resetDb } from '../../helpers/reset-db';
import { PrismaRunnerRepository } from '../../../src/fleet/runners/prisma-runner.repository';

const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;

describeIntegration('enrollment retention (PG)', () => {
  const prisma = new PrismaClient();
  const repo = new PrismaRunnerRepository({ client: prisma } as unknown as PrismaService<PrismaClient>);
  const day = (n: number) => new Date(Date.UTC(2026, 9, n));

  beforeAll(async () => {
    await resetDb();
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('deletes used-before-cutoff and expired-unused-before-cutoff rows only', async () => {
    const row = (tokenHash: string, expiresAt: Date, usedAt: Date | null) =>
      prisma.runnerEnrollment.create({ data: { tokenHash, labels: [], expiresAt, usedAt, createdById: 'u' } });
    await row('used-old', day(30), day(1));          // used long ago, expiry in the future -> deleted
    await row('expired-old', day(2), null);          // never used, expired long ago -> deleted
    await row('used-recent', day(30), day(20));      // kept
    await row('open', day(30), null);                // kept: never used, not expired
    await row('expired-recent', day(19), null);      // kept: expired after the cutoff

    expect(await repo.deleteSpentEnrollmentsBefore(day(10))).toBe(2);
    const left = (await prisma.runnerEnrollment.findMany({ select: { tokenHash: true } })).map((r) => r.tokenHash).sort();
    expect(left).toEqual(['expired-recent', 'open', 'used-recent']);
  });
});
