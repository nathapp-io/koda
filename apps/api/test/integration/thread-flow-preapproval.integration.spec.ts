import { canRunDbTests } from '../helpers/test-environment';
import { resetDb } from '../helpers/reset-db';
import { seedFleetBase, insertRunner } from '../helpers/fleet-fixtures';
import type { PrismaClient } from '../../src/generated/prisma/client';
import type { ITransactionManager } from '@nathapp/nestjs-data';
import { TRANSACTION_MANAGER } from '@nathapp/nestjs-data';
import { PrismaService } from '@nathapp/nestjs-prisma';
import type { NathApplication } from '@nathapp/nestjs-app';
import { AuditRecorder } from '../../src/audit/audit-recorder.service';
import { ThreadsService } from '../../src/fleet/threads/threads.service';
import { ThreadsController } from '../../src/fleet/threads/threads.controller';
import { bootHttpApp } from '../helpers/http-app';
import { fixtureDb, withTestActor } from '../helpers/action-context';

const describeDb = canRunDbTests() ? describe : describe.skip;

describeDb('thread flow pre-approval', () => {
  let app: NathApplication;
  let prisma: PrismaClient;
  let projectId: string;
  let repoId: string;
  let service: ThreadsService;
  let txManager: ITransactionManager;
  let previousThreadsEnabled: string | undefined;
  let sequence = 0;

  beforeAll(async () => {
    previousThreadsEnabled = process.env.FLEET_THREADS_ENABLED;
    process.env.FLEET_THREADS_ENABLED = 'true';
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    prisma = fixtureDb(app);
    ({ projectId, repoId } = await seedFleetBase(prisma));
    service = app.get(ThreadsService, { strict: false });
    txManager = app.get(TRANSACTION_MANAGER, { strict: false });
    expect(app.get(AuditRecorder, { strict: false })).toBeInstanceOf(AuditRecorder);
    expect(app.get(PrismaService, { strict: false })).toBeDefined();
  }, 60_000);

  afterAll(async () => {
    try { await app?.close(); }
    finally {
      if (previousThreadsEnabled === undefined) delete process.env.FLEET_THREADS_ENABLED;
      else process.env.FLEET_THREADS_ENABLED = previousThreadsEnabled;
    }
  });

  async function thread(overrides: Record<string, unknown> = {}) {
    return prisma.chatThread.create({ data: {
      projectId, repoId, title: 'flow thread', createdById: 'creator', backend: {}, skills: [],
      baseRef: 'main', feature: `feature-${++sequence}`, specPath: '.nax/features/feature/spec.md', ...overrides,
    } });
  }

  const auditRows = (threadId: string) => prisma.auditEntry.findMany({
    where: { key: 'fleet.thread.preapprove', resourceType: 'thread', resourceId: threadId },
  });

  it('AC-1/2: persists, maps and audits the tick', async () => {
    const row = await thread();
    await withTestActor({ type: 'USER', id: 'preapproval-user' }, () => service.setPreApproval(projectId, row.id, 'preapproval-user', '30'));
    const result = await service.get(projectId, row.id);
    expect(result.preApproval).toMatchObject({ userId: 'preapproval-user', costCapUsd: '30' });
    expect(Date.parse(result.preApproval?.at ?? '')).not.toBeNaN();
    const entries = await auditRows(row.id);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ key: 'fleet.thread.preapprove', resourceType: 'thread', resourceId: row.id, projectId });
  });

  it('AC-13: thread GET handler exposes the stored tick and null when absent', async () => {
    const ticked = await thread({ preApproval: { userId: 'preapproval-user', at: '2026-01-01T00:00:00.000Z', costCapUsd: '30' } });
    const unticked = await thread();
    const controller = Object.create(ThreadsController.prototype) as ThreadsController;
    Object.defineProperty(controller, 'threads', { value: { get: async (_projectId: string, id: string) => service.get(projectId, id) } });
    const responseWithTick = await controller.get(ticked.id, { project: { id: projectId } } as never);
    const responseWithoutTick = await controller.get(unticked.id, { project: { id: projectId } } as never);
    expect(responseWithTick).toMatchObject({ data: { preApproval: { userId: 'preapproval-user', costCapUsd: '30' } } });
    expect(responseWithoutTick).toMatchObject({ data: { preApproval: null } });
  });

  it('AC-3: refuses to set pre-approval on an archived thread', async () => {
    const row = await thread({ status: 'ARCHIVED', archivedAt: new Date() });
    await expect(withTestActor({ type: 'USER', id: 'preapproval-user' }, () => service.setPreApproval(projectId, row.id, 'preapproval-user', '30')))
      .rejects.toMatchObject({ prefix: 'threads.archived' });
    expect(await auditRows(row.id)).toHaveLength(0);
  });

  it('AC-4/5/6: audits clear exactly once; no-op clear and consume add no audit', async () => {
    const row = await thread({ preApproval: { userId: 'preapproval-user', at: '2026-01-01T00:00:00.000Z', costCapUsd: '30' } });
    await withTestActor({ type: 'USER', id: 'preapproval-user' }, async () => {
      expect(await service.clearPreApproval(projectId, row.id)).toBe(true);
    });
    expect((await service.get(projectId, row.id)).preApproval).toBeNull();
    const afterClear = await auditRows(row.id);
    expect(afterClear).toHaveLength(1);
    expect(afterClear[0]).toMatchObject({ key: 'fleet.thread.preapprove', resourceType: 'thread', resourceId: row.id, projectId });
    await withTestActor({ type: 'USER', id: 'preapproval-user' }, async () => {
      expect(await service.clearPreApproval(projectId, row.id)).toBe(false);
    });
    expect(await auditRows(row.id)).toHaveLength(1);
    await withTestActor({ type: 'USER', id: 'preapproval-user' }, async () => {
      await prisma.chatThread.update({ where: { id: row.id }, data: { preApproval: { userId: 'preapproval-user', at: new Date().toISOString(), costCapUsd: '30' } } });
      await txManager.run(() => service.consumePreApproval(row.id));
    });
    expect((await service.get(projectId, row.id)).preApproval).toBeNull();
    expect(await auditRows(row.id)).toHaveLength(1);
  });

  it('AC-7/10/11/15: flow lock returns the tick and applies guard precedence', async () => {
    const runner = await insertRunner(prisma);
    const ready = await thread({ runnerId: runner.id, specPublished: true, publishedSha: 'abc' });
    await withTestActor({ type: 'USER', id: 'preapproval-user' }, () => service.setPreApproval(projectId, ready.id, 'preapproval-user', '30'));
    await txManager.run(async () => {
      expect(await service.lockForFlow(projectId, ready.id)).toMatchObject({ id: ready.id, preApproval: { costCapUsd: '30' } });
    });

    const unpublished = await thread({ runnerId: runner.id });
    await txManager.run(() => expect(service.lockForFlow(projectId, unpublished.id)).rejects.toMatchObject({ prefix: 'threads.notPublished' }));
    const missingRunner = await thread({ specPublished: true });
    await txManager.run(() => expect(service.lockForFlow(projectId, missingRunner.id)).rejects.toMatchObject({ prefix: 'threads.runnerMissing' }));

    const disabled = new ThreadsService(service['threads'], {} as never, {} as never, { threadsEnabled: false } as never, {} as never, {} as never, {} as never, {} as never);
    await txManager.run(() => expect(disabled.lockForFlow('wrong-project', ready.id)).rejects.toMatchObject({ prefix: 'threads.notFound' }));
    const projectThread = await thread({ kind: 'PROJECT', repoId: null, baseRef: null, feature: null, specPath: null });
    await txManager.run(() => expect(disabled.lockForFlow(projectId, projectThread.id)).rejects.toMatchObject({ prefix: 'threads.notRepoThread' }));
    const archived = await thread({ status: 'ARCHIVED', specPublished: false, runnerId: null });
    await txManager.run(() => expect(disabled.lockForFlow(projectId, archived.id)).rejects.toMatchObject({ prefix: 'threads.disabled' }));
    const enabled = new ThreadsService(service['threads'], {} as never, {} as never, { threadsEnabled: true } as never, {} as never, {} as never, {} as never, {} as never);
    await txManager.run(() => expect(enabled.lockForFlow(projectId, archived.id)).rejects.toMatchObject({ prefix: 'threads.archived' }));
  });

  it('AC-8/9: lock scopes by project and refuses PROJECT threads', async () => {
    const own = await thread({ specPublished: true });
    await txManager.run(() => expect(service.lockForFlow('another-project', own.id)).rejects.toMatchObject({ prefix: 'threads.notFound' }));
    const project = await thread({ kind: 'PROJECT', repoId: null, baseRef: null, feature: null, specPath: null });
    await txManager.run(() => expect(service.lockForFlow(projectId, project.id)).rejects.toMatchObject({ prefix: 'threads.notRepoThread' }));
  });

  it('AC-12: concurrent set waits for lockForFlow held in a real transaction', async () => {
    const runner = await insertRunner(prisma);
    const row = await thread({ runnerId: runner.id, specPublished: true });
    let releaseLock!: () => void;
    let lockHeld!: () => void;
    const held = new Promise<void>((resolve) => { lockHeld = resolve; });
    const release = new Promise<void>((resolve) => { releaseLock = resolve; });
    let holder: Promise<unknown> | undefined;
    let mutation: Promise<unknown> | undefined;
    try {
      holder = txManager.run(() => withTestActor({ type: 'USER', id: 'flow-lock-holder' }, async () => {
        await service.lockForFlow(projectId, row.id);
        lockHeld();
        await release;
      }));
      await held;
      let completed = false;
      mutation = withTestActor({ type: 'USER', id: 'preapproval-user' }, () => service.setPreApproval(projectId, row.id, 'preapproval-user', '30'))
        .then(() => { completed = true; });
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(completed).toBe(false);
    } finally {
      releaseLock();
      await Promise.allSettled([holder, mutation].filter((value): value is Promise<unknown> => value !== undefined));
    }
    expect((await service.get(projectId, row.id)).preApproval).toMatchObject({ userId: 'preapproval-user', costCapUsd: '30' });
  });

  it('AC-14: set and clear preserve mapped publication, runner and session fields', async () => {
    const originalSession = { jobId: 'job', state: 'live', resumed: false, contextReset: false, reason: null, at: '2026-01-01T00:00:00.000Z' };
    const approvals = [{ requestId: 'q1', tool: 'write_doc', summary: 'Write the design', expiresAt: '2026-01-02T00:00:00.000Z' }];
    const row = await thread({ runnerId: (await insertRunner(prisma)).id, specPublished: true, publishedSha: 'published', mode: 'ask', pendingApprovals: approvals, pendingQuestion: { requestId: 'p', text: 'Question' }, session: originalSession });
    const expected = { publishedSha: 'published', specPublished: true, runnerId: row.runnerId, mode: 'ask', pendingApprovals: approvals, pendingQuestion: { requestId: 'p', text: 'Question' }, session: originalSession };
    await withTestActor({ type: 'USER', id: 'preapproval-user' }, async () => {
      await service.setPreApproval(projectId, row.id, 'preapproval-user', '30');
    });
    expect(await service.get(projectId, row.id)).toMatchObject({ ...expected, preApproval: { costCapUsd: '30' } });
    await withTestActor({ type: 'USER', id: 'preapproval-user' }, async () => {
      expect(await service.clearPreApproval(projectId, row.id)).toBe(true);
    });
    expect(await service.get(projectId, row.id)).toMatchObject({ ...expected, preApproval: null });
  });
});
