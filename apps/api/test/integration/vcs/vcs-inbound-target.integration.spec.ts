/**
 * Track 3 Slice 2b: the inbound VCS webhook resolves its connection by project
 * slug in one query. Unknown slugs, soft-deleted projects and projects without a
 * connection all come back as null, so the controller can answer each with the
 * same 401.
 *
 * Run: cd apps/api && bun run test:db:up && bun run test:scoped test/integration/vcs/vcs-inbound-target.integration.spec.ts
 */
import { PrismaClient } from '@prisma/client';
import { PrismaService } from '@nathapp/nestjs-prisma';
import type { ITransactionManager } from '@nathapp/nestjs-data';
import { PrismaVcsRepository } from '../../../src/vcs/prisma-vcs.repository';
import { resetDb } from '../../helpers/reset-db';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;

describeIntegration('PrismaVcsRepository.findVcsConnectionByProjectSlug (Slice 2b)', () => {
  jest.setTimeout(20000);
  let prismaService: PrismaService<PrismaClient>;
  let prisma: PrismaClient;
  let repo: PrismaVcsRepository;
  let liveProjectId: string;

  beforeAll(async () => {
    if (!DATABASE_URL) return;

    await resetDb(DATABASE_URL);

    prismaService = new PrismaService({
      client: PrismaClient,
      clientOptions: { datasources: { db: { url: DATABASE_URL } } },
    });
    await prismaService.onModuleInit();
    prisma = prismaService.client;

    // PrismaVcsRepository reads through PrismaService.client, never the tx client.
    const txManager: ITransactionManager = {
      run: <T>(fn: () => Promise<T>): Promise<T> => fn(),
      getClient: <C = unknown>(): C => prisma as unknown as C,
      isInTransaction: () => false,
    };
    repo = new PrismaVcsRepository(txManager, prismaService);

    const live = await prisma.project.create({ data: { name: 'Inbound Live', slug: 'inbound-live', key: 'INL' } });
    const deleted = await prisma.project.create({
      data: { name: 'Inbound Deleted', slug: 'inbound-deleted', key: 'IND', deletedAt: new Date() },
    });
    await prisma.project.create({ data: { name: 'Inbound Bare', slug: 'inbound-bare', key: 'INB' } });
    liveProjectId = live.id;

    for (const project of [live, deleted]) {
      await prisma.vcsConnection.create({
        data: {
          projectId: project.id,
          provider: 'github',
          repoOwner: 'owner',
          repoName: `repo-${project.key}`,
          encryptedToken: 'enc',
          syncMode: 'webhook',
          webhookSecret: `secret-${project.key}`,
        },
      });
    }
  });

  afterAll(async () => {
    if (prismaService) {
      await prismaService.onModuleDestroy();
    }
  });

  it('returns the connection with its project for a live project', async () => {
    const result = await repo.findVcsConnectionByProjectSlug('inbound-live');

    if (!result) {
      throw new Error('expected a connection for a live project');
    }
    expect(result.projectId).toBe(liveProjectId);
    expect(result.webhookSecret).toBe('secret-INL');
    expect(result.syncMode).toBe('webhook');
    expect(result.isActive).toBe(true);
    expect(result.project).toEqual({ id: liveProjectId, key: 'INL', slug: 'inbound-live' });
  });

  it.each([
    ['an unknown slug', 'no-such-project'],
    ['a soft-deleted project', 'inbound-deleted'],
    ['a project without a VCS connection', 'inbound-bare'],
  ])('returns null for %s', async (_label, slug) => {
    await expect(repo.findVcsConnectionByProjectSlug(slug)).resolves.toBeNull();
  });
});
