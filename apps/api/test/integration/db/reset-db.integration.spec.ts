/**
 * resetDb() must empty every application table on Postgres and leave
 * _prisma_migrations alone.
 *
 * Run: cd apps/api && bun run test:integration -- test/integration/db/reset-db.integration.spec.ts
 */
import { PrismaClient } from '@prisma/client';
import { resetDb } from '../../helpers/reset-db';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;

describeIntegration('resetDb (Postgres)', () => {
  const prisma = new PrismaClient({ datasources: { db: { url: DATABASE_URL } } });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('empties application tables', async () => {
    await resetDb();
    const project = await prisma.project.create({
      data: { name: 'P', slug: 'reset-p', key: 'RST' },
    });
    await prisma.ticket.create({
      data: { projectId: project.id, number: 1, type: 'TASK', title: 't', status: 'CREATED', priority: 'MEDIUM' },
    });

    await resetDb();

    expect(await prisma.project.count()).toBe(0);
    expect(await prisma.ticket.count()).toBe(0);
  });

  it('is safe to call twice in a row', async () => {
    await resetDb();
    await expect(resetDb()).resolves.toBeUndefined();
  });
});
