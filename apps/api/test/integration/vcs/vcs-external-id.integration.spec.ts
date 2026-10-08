/**
 * Track 3 Slice 4 (M11): dedup includes soft-deleted tickets, and imports store
 * the id they are given.
 * Run: cd apps/api && bun run test:db:up && bun run test:scoped test/integration/vcs/vcs-external-id.integration.spec.ts
 */
import { PrismaClient } from '../../../src/generated/prisma/client';
import { PrismaService } from '@nathapp/nestjs-prisma';
import type { ITransactionManager } from '@nathapp/nestjs-data';
import { PrismaVcsRepository } from '../../../src/vcs/prisma-vcs.repository';
import { resetDb } from '../../helpers/reset-db';
import { createPgAdapter } from '../../../src/prisma/pg-adapter';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;

describeIntegration('PrismaVcsRepository external ids (M11)', () => {
  jest.setTimeout(20000);
  let prismaService: PrismaService<PrismaClient>;
  let prisma: PrismaClient;
  let repo: PrismaVcsRepository;
  let projectId: string;

  beforeAll(async () => {
    if (!DATABASE_URL) return;
    await resetDb(DATABASE_URL);
    prismaService = new PrismaService({
      client: PrismaClient,
      clientOptions: { adapter: createPgAdapter(DATABASE_URL) },
    });
    await prismaService.onModuleInit();
    prisma = prismaService.client;
    const txManager: ITransactionManager = {
      run: <T>(fn: () => Promise<T>): Promise<T> => fn(),
      getClient: <C = unknown>(): C => prisma as unknown as C,
      isInTransaction: () => false,
    };
    repo = new PrismaVcsRepository(txManager, prismaService);
    projectId = (await prisma.project.create({ data: { name: 'Ext', slug: 'ext', key: 'EXT' } })).id;
    await prisma.ticket.create({
      data: {
        projectId,
        number: 1,
        type: 'TASK',
        title: 'Deleted import',
        externalVcsId: 'acme/widgets#5',
        deletedAt: new Date(),
      },
    });
  });

  afterAll(async () => {
    if (prismaService) await prismaService.onModuleDestroy();
  });

  it('finds a soft-deleted imported ticket, so it is never re-imported', async () => {
    const found = await repo.findExistingTicketByExternalId(projectId, 'acme/widgets#5');
    expect(found?.number).toBe(1);
  });

  it('does not match the same issue number from another repository', async () => {
    await expect(repo.findExistingTicketByExternalId(projectId, 'acme/other#5')).resolves.toBeNull();
  });

  it('stores the external id it is given', async () => {
    const issue = { number: 9, title: 'New', body: null, authorLogin: 'a', url: 'https://x/9', labels: [], createdAt: new Date() };
    const created = await repo.createTicketFromIssue({ id: projectId }, issue, 'acme/widgets#9');

    const row = await prisma.ticket.findUniqueOrThrow({ where: { id: created.id } });
    expect(row.externalVcsId).toBe('acme/widgets#9');
    expect(row.number).toBe(2);
  });
});
