import { canRunDbTests } from '../../helpers/test-environment';
/**
 * Fleet S2b (c) slice 1 — dashboard repository reads (PG), spec §1.3.
 * Run: cd apps/api && bun run test:scoped test/integration/fleet/fleet-dashboard-repository.integration.spec.ts
 */
import { NathApplication } from '@nathapp/nestjs-app';
import { Prisma, PrismaClient } from '../../../src/generated/prisma/client';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp } from '../../helpers/http-app';
import { insertRunner, seedFleetBase } from '../../helpers/fleet-fixtures';
import { seedFleetAsk } from '../../helpers/fleet-ask-fixtures';
import { PrismaDashboardRepository } from '../../../src/fleet/dashboard/prisma-dashboard.repository';
import { expectGuardActive, fixtureDb } from '../../helpers/action-context';

// The nax sandbox withholds host Postgres/Docker.
const describeIntegration = canRunDbTests() ? describe : describe.skip;

describeIntegration('fleet dashboard repository (PG)', () => {
  let app: NathApplication;
  let prisma: PrismaClient;
  let repo: PrismaDashboardRepository;
  let web: Awaited<ReturnType<typeof seedFleetBase>>;
  let ops: Awaited<ReturnType<typeof seedFleetBase>>;
  let gone: Awaited<ReturnType<typeof seedFleetBase>>;
  let runnerId: string;
  let n = 0;
  const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000);

  const job = (base: { projectId: string; repoId: string; adminId: string }, over: Partial<Prisma.FleetJobUncheckedCreateInput> = {}) =>
    prisma.fleetJob.create({
      data: {
        projectId: base.projectId, repoId: base.repoId, ref: 'main', command: 'RUN', feature: `f${++n}`, profiles: ['fast'],
        maxCostUsd: new Prisma.Decimal('2.5'), selectorLabels: [], requestedById: base.adminId, ...over,
      },
    });

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    prisma = fixtureDb(app);
    repo = app.get(PrismaDashboardRepository);
    web = await seedFleetBase(prisma);
    ops = await seedFleetBase(prisma);
    gone = await seedFleetBase(prisma);
    await prisma.project.update({ where: { id: gone.projectId }, data: { deletedAt: new Date() } });
    runnerId = (await insertRunner(prisma, { name: 'b-runner' })).id;
    await insertRunner(prisma, { name: 'a-runner' });
  });
  afterAll(async () => {
    await app.close();
  });

  it('writes need an action context', async () => {
    await expect(expectGuardActive(app)).resolves.toBeUndefined();
  });

  it('lists runners by name with their raw capabilities', async () => {
    const runners = await repo.findRunners();
    expect(runners.map((r) => r.name)).toEqual(['a-runner', 'b-runner']);
    expect(runners[0]).toEqual(expect.objectContaining({ os: 'linux', arch: 'x64', capacity: 1, daemonVersion: '0.1.0', enabled: true }));
    expect((runners[0].capabilities as { nax: { version: string } }).nax.version).toBe('0.83.0');
  });

  it('reads active jobs per scope, skipping soft-deleted projects, with repo and project fields', async () => {
    const running = await job(web, { state: 'RUNNING', runnerId, queuedAt: minutesAgo(30), costSpentUsd: new Prisma.Decimal('0.125'), stories: [{ id: 'US-1', title: 't', status: 'passed', attempts: 1, dependsOn: [] }] as unknown as Prisma.InputJsonValue });
    const queued = await job(ops, { queuedAt: minutesAgo(20) });
    await job(gone, { queuedAt: minutesAgo(40) });
    const all = await repo.findActiveJobs({ kind: 'global' }, 10);
    expect(all.map((j) => j.id)).toEqual([running.id, queued.id]);
    expect(all[0]).toEqual(expect.objectContaining({
      projectSlug: web.projectSlug, projectDeleted: false, repoOwner: 'acme', provider: 'github', state: 'RUNNING', runnerId,
      costSpentUsd: '0.125', maxCostUsd: '2.5', stories: [expect.objectContaining({ id: 'US-1', status: 'passed' })],
    }));
    expect((await repo.findActiveJobs({ kind: 'project', projectId: ops.projectId }, 10)).map((j) => j.id)).toEqual([queued.id]);
    expect(await repo.findActiveJobs({ kind: 'global' }, 1)).toHaveLength(1);
  });

  it('reads the global queued window including soft-deleted projects, flagged', async () => {
    const window = await repo.findQueuedWindow(50);
    expect(window.map((j) => j.projectDeleted)).toEqual([true, false]);
  });

  it('counts active states per scope and lists held refs across projects', async () => {
    expect(Object.fromEntries(await repo.countActiveByState({ kind: 'global' }))).toEqual({ RUNNING: 1, QUEUED: 1 });
    expect(Object.fromEntries(await repo.countActiveByState({ kind: 'project', projectId: web.projectId }))).toEqual({ RUNNING: 1 });
    expect(await repo.findHeldRefs()).toEqual([{ runnerId, repoId: web.repoId, command: 'RUN' }]);
  });

  it('reads recent terminal jobs inside the window, newest first, with the runner name', async () => {
    const newer = await job(web, { state: 'COMPLETED', runnerId, finishedAt: minutesAgo(5), resultPrUrl: 'https://x/pr/1' });
    const older = await job(web, { state: 'FAILED', stateReason: 'boom', finishedAt: minutesAgo(50) });
    await job(web, { state: 'COMPLETED', finishedAt: minutesAgo(60 * 25) });
    const recent = await repo.findRecentJobs({ kind: 'project', projectId: web.projectId }, minutesAgo(60 * 24), 10);
    expect(recent.map((r) => r.id)).toEqual([newer.id, older.id]);
    expect(recent[0]).toEqual(expect.objectContaining({ runnerName: 'b-runner', resultPrUrl: 'https://x/pr/1', repoName: expect.any(String) }));
    expect(recent[1]).toEqual(expect.objectContaining({ runnerName: null, stateReason: 'boom' }));
  });

  it('US-011 AC-8: summarises pending engine asks per job: count and the older link createdAt', async () => {
    const target = await job(web, { feature: 'asks', state: 'RUNNING', runnerId });
    const older = minutesAgo(3);
    const newer = minutesAgo(1);
    // Permissions P3 US-011: the ask is an engine request; the link is written in its transaction, so the link's
    // `createdAt` is the ask's age.
    const ask = (createdAt: Date, status: 'pending' | 'executed') => {
      const naxAskId = `ask-${createdAt.getTime()}`;
      return seedFleetAsk(prisma, {
        kind: 'bash', projectId: web.projectId, createdAt, status,
        input: { jobId: target.id, leaseEpoch: 1, naxAskId, payload: { command: 'ls', commandTruncated: false, options: ['allow'] } },
        link: { jobId: target.id, leaseEpoch: 1, naxAskId },
        ...(status === 'pending'
          ? {}
          : { decisions: [{ deciderType: 'USER' as const, deciderId: web.adminId, decision: 'approve' as const }] }),
      });
    };
    await ask(older, 'pending');
    await ask(newer, 'pending');
    await ask(minutesAgo(9), 'executed');

    expect(await repo.pendingSummaryByJob([target.id, 'nope'])).toEqual([
      { jobId: target.id, count: 2, oldestRequestedAt: older },
    ]);
    expect(await repo.pendingSummaryByJob([])).toEqual([]);
  });

  it('US-007 AC6: a held THREAD job is listed with command THREAD', async () => {
    const threadRunnerId = (await insertRunner(prisma, { name: 'thread-holder' })).id;
    await job(web, { command: 'THREAD', feature: 'thread-held', state: 'RUNNING', runnerId: threadRunnerId });
    expect(await repo.findHeldRefs()).toContainEqual({ runnerId: threadRunnerId, repoId: web.repoId, command: 'THREAD' });
  });
});
