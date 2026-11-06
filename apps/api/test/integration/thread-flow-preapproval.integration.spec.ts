import { canRunDbTests } from '../helpers/test-environment';
import { resetDb } from '../helpers/reset-db';
import { createTestPrismaClient } from '../helpers/test-prisma';
import type { PrismaClient } from '../../src/generated/prisma/client';
import { seedFleetBase, insertRunner } from '../helpers/fleet-fixtures';
import { PrismaChatThreadRepository } from '../../src/fleet/threads/prisma-chat-thread.repository';
import { ThreadsService } from '../../src/fleet/threads/threads.service';
import { ThreadsController } from '../../src/fleet/threads/threads.controller';

const describeDb = canRunDbTests() ? describe : describe.skip;
const tx = { run: (fn: () => Promise<unknown>) => fn(), isInTransaction: () => true };

describeDb('thread flow pre-approval', () => {
  let prisma: PrismaClient;
  let projectId: string;
  let repoId: string;
  let service: ThreadsService;
  let repository: PrismaChatThreadRepository;
  let audits: Array<Record<string, unknown>>;
  let sequence = 0;

  beforeAll(async () => {
    await resetDb();
    prisma = createTestPrismaClient();
    ({ projectId, repoId } = await seedFleetBase(prisma));
    audits = [];
    const audit = { record: vi.fn(async (entry: Record<string, unknown>) => { audits.push(entry); }) };
    repository = new PrismaChatThreadRepository(
      { client: prisma } as never, {} as never, tx as never, {} as never, {} as never, {} as never,
      {} as never, { threadsEnabled: true, runnerOfflineSec: 60 } as never, audit as never, {} as never,
    );
    service = new ThreadsService(
      repository, {} as never, {} as never, { threadsEnabled: true } as never,
      {} as never, {} as never, {} as never, {} as never,
    );
  }, 60_000);
  beforeEach(() => { audits = []; });
  afterAll(async () => { await prisma?.$disconnect(); });

  async function thread(overrides: Record<string, unknown> = {}) {
    return prisma.chatThread.create({ data: {
      projectId, repoId, title: 'flow thread', createdById: 'creator', backend: {}, skills: [],
      baseRef: 'main', feature: `feature-${++sequence}`, specPath: '.nax/features/feature/spec.md', ...overrides,
    } });
  }

  it('AC-1/2: sets, maps and audits the tick', async () => {
    const row = await thread();
    await service.setPreApproval(projectId, row.id, 'user-1', '30');
    expect(await repository.get({ kind: 'project', projectId }, row.id)).toMatchObject({ preApproval: { userId: 'user-1', costCapUsd: '30' } });
    expect(audits).toContainEqual(expect.objectContaining({ key: 'fleet.thread.preapprove', resourceType: 'thread', resourceId: row.id }));
  });

  it('AC-13: thread GET handler exposes the stored tick and null when absent', async () => {
    const ticked = await thread({ preApproval: { userId: 'user-1', at: '2026-01-01T00:00:00.000Z', costCapUsd: '30' } });
    const unticked = await thread();
    const controller = Object.create(ThreadsController.prototype) as ThreadsController;
    Object.defineProperty(controller, 'threads', { value: { get: async (_projectId: string, id: string) => repository.get({ kind: 'project', projectId }, id) } });
    const responseWithTick = await controller.get(ticked.id, { project: { id: projectId } } as never);
    const responseWithoutTick = await controller.get(unticked.id, { project: { id: projectId } } as never);
    expect(responseWithTick).toMatchObject({ data: { preApproval: { userId: 'user-1', costCapUsd: '30' } } });
    expect(responseWithoutTick).toMatchObject({ data: { preApproval: null } });
  });

  it('AC-3: refuses to set pre-approval on an archived thread', async () => {
    const row = await thread({ status: 'ARCHIVED', archivedAt: new Date() });
    await expect(service.setPreApproval(projectId, row.id, 'user-1', '30')).rejects.toMatchObject({ prefix: 'threads.archived' });
    expect(audits).toHaveLength(0);
  });

  it('AC-4/5/6: clears and consumes without auditing no-op or consumption', async () => {
    const row = await thread({ preApproval: { userId: 'user-1', at: '2026-01-01T00:00:00.000Z', costCapUsd: '30' } });
    expect(await service.clearPreApproval(projectId, row.id)).toBe(true);
    expect((await prisma.chatThread.findUniqueOrThrow({ where: { id: row.id } })).preApproval).toBeNull();
    expect(audits).toHaveLength(1);
    expect(await service.clearPreApproval(projectId, row.id)).toBe(false);
    expect(audits).toHaveLength(1);
    await prisma.chatThread.update({ where: { id: row.id }, data: { preApproval: { userId: 'user-1', at: new Date().toISOString(), costCapUsd: '30' } } });
    await service.consumePreApproval(row.id);
    expect((await prisma.chatThread.findUniqueOrThrow({ where: { id: row.id } })).preApproval).toBeNull();
    expect(audits).toHaveLength(1);
  });

  it('AC-7/10/11/15: flow lock returns a published repo record and checks ordered guards', async () => {
    const runner = await insertRunner(prisma);
    const ready = await thread({ runnerId: runner.id, specPublished: true, publishedSha: 'abc' });
    await service.setPreApproval(projectId, ready.id, 'user-1', '30');
    expect(await service.lockForFlow(projectId, ready.id)).toMatchObject({ id: ready.id, preApproval: { costCapUsd: '30' } });
    const unpublished = await thread({ runnerId: runner.id });
    await expect(service.lockForFlow(projectId, unpublished.id)).rejects.toMatchObject({ prefix: 'threads.notPublished' });
    const missingRunner = await thread({ specPublished: true });
    await expect(service.lockForFlow(projectId, missingRunner.id)).rejects.toMatchObject({ prefix: 'threads.runnerMissing' });
    const disabled = new ThreadsService({ lockForFlow: vi.fn().mockResolvedValue(await repository.get({ kind: 'project', projectId }, ready.id)) } as never, {} as never, {} as never, { threadsEnabled: false } as never, {} as never, {} as never, {} as never, {} as never);
    await expect(disabled.lockForFlow(projectId, ready.id)).rejects.toMatchObject({ prefix: 'threads.disabled' });
    const archived = await thread({ status: 'ARCHIVED', specPublished: true, runnerId: runner.id });
    await expect(service.lockForFlow(projectId, archived.id)).rejects.toMatchObject({ prefix: 'threads.archived' });
  });

  it('AC-8/9: lock scopes by project and refuses PROJECT threads', async () => {
    const own = await thread({ specPublished: true });
    await expect(service.lockForFlow('another-project', own.id)).rejects.toMatchObject({ prefix: 'threads.notFound' });
    const project = await thread({ kind: 'PROJECT', repoId: null, baseRef: null, feature: null, specPath: null });
    await expect(service.lockForFlow(projectId, project.id)).rejects.toMatchObject({ prefix: 'threads.notRepoThread' });
  });

  it('AC-12: pre-approval mutation waits for a held thread row lock', async () => {
    const row = await thread();
    let releaseLock!: () => void;
    let lockHeld!: () => void;
    const held = new Promise<void>((resolve) => { lockHeld = resolve; });
    const release = new Promise<void>((resolve) => { releaseLock = resolve; });
    const locker = prisma.$transaction(async (connection) => {
      await connection.$queryRaw`SELECT "id" FROM "ChatThread" WHERE "id" = ${row.id} FOR UPDATE`;
      lockHeld();
      await release;
    });
    await held;
    let completed = false;
    const mutation = service.setPreApproval(projectId, row.id, 'user-1', '30').then(() => { completed = true; });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(completed).toBe(false);
    releaseLock();
    await Promise.all([locker, mutation]);
    expect(completed).toBe(true);
  });

  it('AC-14: tick mutations preserve unrelated published/session fields', async () => {
    const originalSession = { jobId: 'job', state: 'live', resumed: false, contextReset: false, reason: null, at: '2026-01-01T00:00:00.000Z' };
    const row = await thread({ runnerId: (await insertRunner(prisma)).id, specPublished: true, publishedSha: 'published', mode: 'ask', pendingApprovals: [{ requestId: 'q' }], pendingQuestion: { requestId: 'p' }, session: originalSession });
    await service.setPreApproval(projectId, row.id, 'user-1', '30');
    const updated = await prisma.chatThread.findUniqueOrThrow({ where: { id: row.id } });
    expect(updated).toMatchObject({ publishedSha: 'published', specPublished: true, runnerId: row.runnerId, mode: 'ask', pendingApprovals: [{ requestId: 'q' }], pendingQuestion: { requestId: 'p' }, session: originalSession });
  });
});
