import { canRunDbTests } from '../../helpers/test-environment';
/**
 * US-003 fix round 1 (F1): the pinned connection write is atomic on the connection id.
 *
 * `VcsConnectionService.update`/`.rotateWebhookSecret` read the project's connection and then write
 * it. A connection deleted and recreated between those two steps must not be the row that changes, so
 * the pinned write targets `(connection: id, projectId)` itself instead of the project — the stale id
 * matches nothing, answers null (the service turns that into 404 `vcs`) and the replacement keeps the
 * values it was created with.
 *
 * Run: cd apps/api && bun run test:db:up && bun run test:scoped test/integration/vcs/vcs-connection-pin.integration.spec.ts
 */
import { PrismaClient } from '../../../src/generated/prisma/client';
import { PrismaService } from '@nathapp/nestjs-prisma';
import type { ITransactionManager } from '@nathapp/nestjs-data';
import { PrismaVcsRepository } from '../../../src/vcs/prisma-vcs.repository';
import { resetDb } from '../../helpers/reset-db';
import { createPgAdapter } from '../../../src/prisma/pg-adapter';

const DATABASE_URL = process.env.DATABASE_URL;
// The nax sandbox withholds host Postgres/Docker.
const describeIntegration = canRunDbTests() ? describe : describe.skip;

describeIntegration('PrismaVcsRepository.updateVcsConnectionById (US-003 F1)', () => {
  vi.setConfig({ testTimeout: 20000 });
  let prismaService: PrismaService<PrismaClient>;
  let prisma: PrismaClient;
  let repo: PrismaVcsRepository;
  let projectId: string;
  let otherProjectId: string;

  const makeConnection = async (
    project: string,
    over: { syncMode?: string; webhookSecret?: string | null } = {},
  ) => prisma.vcsConnection.create({
    data: {
      projectId: project,
      provider: 'github',
      repoOwner: 'acme',
      repoName: 'widgets',
      encryptedToken: 'enc',
      syncMode: over.syncMode ?? 'off',
      webhookSecret: over.webhookSecret ?? null,
    },
  });

  const current = async (id: string) => prisma.vcsConnection.findUniqueOrThrow({ where: { id } });

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
    projectId = (await prisma.project.create({ data: { name: 'Pin', slug: 'pin', key: 'PIN' } })).id;
    otherProjectId = (await prisma.project.create({ data: { name: 'Pin other', slug: 'pin-other', key: 'PNO' } })).id;
  });

  afterAll(async () => {
    if (prismaService) await prismaService.onModuleDestroy();
  });

  beforeEach(async () => {
    await prisma.vcsConnection.deleteMany({ where: { projectId: { in: [projectId, otherProjectId] } } });
  });

  it('F1: a replaced connection is never the row a stale id writes', async () => {
    const replaced = await makeConnection(projectId, { syncMode: 'off' });
    await prisma.vcsConnection.delete({ where: { id: replaced.id } });
    const replacement = await makeConnection(projectId, { syncMode: 'off' });

    const written = await repo.updateVcsConnectionById(replaced.id, projectId, { syncMode: 'polling' });

    expect(written).toBeNull();
    expect((await current(replacement.id)).syncMode).toBe('off');
  });

  it('F1: the pinned row is written when it is still the project connection', async () => {
    const connection = await makeConnection(projectId, { syncMode: 'off' });

    const written = await repo.updateVcsConnectionById(connection.id, projectId, { syncMode: 'polling' });

    expect(written?.id).toBe(connection.id);
    expect((await current(connection.id)).syncMode).toBe('polling');
  });

  it('F1: a rotation pinned to a replaced connection leaves the replacement secret alone', async () => {
    const replaced = await makeConnection(projectId, { webhookSecret: 'old'.padEnd(32, '0') });
    await prisma.vcsConnection.delete({ where: { id: replaced.id } });
    const replacement = await makeConnection(projectId, { webhookSecret: 'new'.padEnd(32, '1') });

    const written = await repo.updateVcsConnectionById(replaced.id, projectId, { webhookSecret: 'rotated'.padEnd(32, '2') });

    expect(written).toBeNull();
    expect((await current(replacement.id)).webhookSecret).toBe('new'.padEnd(32, '1'));
  });

  it('F1: a pinned id from another project writes nothing', async () => {
    const foreign = await makeConnection(otherProjectId, { webhookSecret: 'old'.padEnd(32, '0') });

    const written = await repo.updateVcsConnectionById(foreign.id, projectId, { webhookSecret: 'gone' });

    expect(written).toBeNull();
    expect((await current(foreign.id)).webhookSecret).toBe('old'.padEnd(32, '0'));
  });

  it('F1: the legacy project-scoped write still updates the project connection', async () => {
    const connection = await makeConnection(projectId, { syncMode: 'off' });

    const written = await repo.updateVcsConnection(projectId, { syncMode: 'polling' });

    expect(written.id).toBe(connection.id);
    expect((await current(connection.id)).syncMode).toBe('polling');
  });
});
