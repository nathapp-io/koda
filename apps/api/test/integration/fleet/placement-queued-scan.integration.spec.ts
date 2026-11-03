import { canRunDbTests } from '../../helpers/test-environment';
/**
 * Review P2 US-004 — the QUEUED scan on PG: the fill filter is SQL (state, live project, kind, pin) and paging is a
 * bounded keyset cursor on `(queuedAt, id)`, so a page of jobs this runner can never take cannot hide newer ones.
 *
 * The first block drives `findQueuedPage` directly; the second drives both real fill entry points so the filter and
 * the page loop are exercised as placement uses them.
 * Run: cd apps/api && bun run test:scoped test/integration/fleet/placement-queued-scan.integration.spec.ts
 */
import { NathApplication } from '@nathapp/nestjs-app';
import { Prisma, PrismaClient } from '../../../src/generated/prisma/client';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp } from '../../helpers/http-app';
import { fixtureDb, withTestActor } from '../../helpers/action-context';
import { FLEET_CAPS } from '../../helpers/fleet-fixtures';
import { PrismaFleetJobRepository } from '../../../src/fleet/jobs/prisma-fleet-job.repository';
import type { QueuedScanFilter } from '../../../src/fleet/jobs/domain/fleet-job.domain';
import { MAX_QUEUED_SCAN_PAGES, QUEUED_SCAN_LIMIT } from '../../../src/fleet/jobs/placement-rules';
import { PlacementService } from '../../../src/fleet/jobs/placement.service';

// The nax sandbox withholds host Postgres/Docker.
const describeIntegration = canRunDbTests() ? describe : describe.skip;
const bind = (client: unknown) => new PrismaFleetJobRepository({ client } as unknown as PrismaService<PrismaClient>);

/** The two scans a runner ever asks for (US-004): its own non-thread work, and its thread turns. */
const WORK: QueuedScanFilter = { runnerId: 'r1', threads: false };
const THREADS: QueuedScanFilter = { runnerId: 'r1', threads: true };

describeIntegration('findQueuedPage (PG)', () => {
  let app: NathApplication;
  let prisma: PrismaClient;
  let repo: PrismaFleetJobRepository;
  let placement: PlacementService;
  let requesterId: string;
  let projectId: string;
  let repoId: string;
  let deletedProjectRepoId: string;

  /** A QUEUED job; `queuedAt` and `id` are given so a keyset page can be asserted row by row. */
  const queue = (feature: string, over: Partial<Prisma.FleetJobUncheckedCreateInput> = {}) => prisma.fleetJob.create({
    data: {
      projectId, repoId, ref: 'main', command: 'RUN', feature, profiles: [], selectorLabels: [], maxCostUsd: new Prisma.Decimal(1),
      requestedById: requesterId, ...over,
    },
    select: { id: true, queuedAt: true },
  });
  /** `fillRunner` is the runner's own sync asking for work, so it runs as that runner. */
  const fillAsRunner = (runnerId: string, slots: number) => withTestActor({ type: 'RUNNER', id: runnerId }, () => placement.fillRunner(runnerId, slots));
  const fillThreadsAsRunner = (runnerId: string) => withTestActor({ type: 'RUNNER', id: runnerId }, () => placement.fillRunnerThreads(runnerId));
  const stateOf = async (id: string) => (await prisma.fleetJob.findUniqueOrThrow({ where: { id } })).state;

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    prisma = fixtureDb(app);
    repo = bind(prisma);
    placement = app.get(PlacementService);
    const user = await prisma.user.create({ data: { email: 'scan@koda.test', passwordHash: 'x' } });
    requesterId = user.id;
    projectId = (await prisma.project.create({ data: { name: 'scan', slug: 'scan', key: 'SCAN' } })).id;
    repoId = (await prisma.fleetRepo.create({
      data: { projectId, provider: 'github', owner: 'acme', name: 'scan', defaultBranch: 'main', githubInstallationId: BigInt(7), createdById: requesterId },
    })).id;
    const gone = await prisma.project.create({ data: { name: 'gone', slug: 'gone', key: 'GONE', deletedAt: new Date() } });
    deletedProjectRepoId = (await prisma.fleetRepo.create({
      data: { projectId: gone.id, provider: 'github', owner: 'acme', name: 'gone', defaultBranch: 'main', githubInstallationId: BigInt(7), createdById: requesterId },
    })).id;
    for (const id of ['r1', 'r2']) {
      await prisma.runner.create({
        data: {
          id, name: `runner-${id}`, apiKeyHash: `hash-${id}`, os: 'linux', arch: 'x64', labels: ['linux'], capacity: 2,
          capabilities: FLEET_CAPS as object, daemonVersion: '0.1.0', protocolVersion: 4, bootId: `boot-${id}`,
          lastSeenAt: new Date(), createdById: requesterId,
        },
      });
    }
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(async () => {
    await prisma.fleetCommand.deleteMany();
    await prisma.fleetJob.deleteMany();
  });

  it('AC-2: leaves out a QUEUED job pinned to another runner', async () => {
    const pinned = await queue('pinned-r2', { pinnedRunnerId: 'r2' });
    const open = await queue('unpinned');

    const ids = (await repo.findQueuedPage(WORK, 50, null)).map((row) => row.id);

    expect(ids).toContain(open.id);
    expect(ids).not.toContain(pinned.id);
  });

  it('AC-3: includes a job pinned to this runner and an unpinned one', async () => {
    const mine = await queue('pinned-r1', { pinnedRunnerId: 'r1' });
    const open = await queue('unpinned');

    const ids = (await repo.findQueuedPage(WORK, 50, null)).map((row) => row.id);

    expect(ids).toEqual(expect.arrayContaining([mine.id, open.id]));
  });

  it('AC-4: leaves out a QUEUED THREAD job when scanning for work', async () => {
    const work = await queue('work');
    const turn = await queue('turn', { command: 'THREAD' });

    const ids = (await repo.findQueuedPage(WORK, 50, null)).map((row) => row.id);

    expect(ids).toEqual([work.id]);
    expect(ids).not.toContain(turn.id);
  });

  it('AC-5: answers only THREAD jobs when scanning for turns', async () => {
    await queue('work');
    const turn = await queue('turn', { command: 'THREAD' });

    expect((await repo.findQueuedPage(THREADS, 50, null)).map((row) => row.id)).toEqual([turn.id]);
  });

  it('AC-6: leaves out a QUEUED job whose project is soft-deleted', async () => {
    const live = await queue('live');
    const orphan = await prisma.fleetJob.create({
      data: {
        projectId: (await prisma.project.findUniqueOrThrow({ where: { slug: 'gone' } })).id, repoId: deletedProjectRepoId,
        ref: 'main', command: 'RUN', feature: 'orphan', profiles: [], selectorLabels: [],
        maxCostUsd: new Prisma.Decimal(1), requestedById: requesterId,
      },
      select: { id: true },
    });

    const ids = (await repo.findQueuedPage(WORK, 50, null)).map((row) => row.id);

    expect(ids).toEqual([live.id]);
    expect(ids).not.toContain(orphan.id);
  });

  it('AC-7: pages by queuedAt then id, and a tie on queuedAt continues past the cursor id', async () => {
    const t0 = new Date('2026-11-01T00:00:00.000Z');
    const t1 = new Date('2026-11-01T00:01:00.000Z');
    const t2 = new Date('2026-11-01T00:02:00.000Z');
    // Ids are chosen, not generated: the second page must resume on `id > cursor.id` inside one queuedAt.
    const a = await queue('a', { id: 'us004-a', queuedAt: t0 });
    const b = await queue('b', { id: 'us004-b', queuedAt: t1 });
    const c = await queue('c', { id: 'us004-c', queuedAt: t1 });
    const d = await queue('d', { id: 'us004-d', queuedAt: t1 });
    const e = await queue('e', { id: 'us004-e', queuedAt: t2 });

    const first = await repo.findQueuedPage(WORK, 2, null);
    expect(first).toEqual([
      { id: a.id, queuedAt: t0 },
      { id: b.id, queuedAt: t1 },
    ]);

    const second = await repo.findQueuedPage(WORK, 2, first[1]);
    expect(second).toEqual([
      { id: c.id, queuedAt: t1 },
      { id: d.id, queuedAt: t1 },
    ]);

    const third = await repo.findQueuedPage(WORK, 2, second[1]);
    expect(third).toEqual([{ id: e.id, queuedAt: t2 }]);
  });

  it('never answers a job that is no longer QUEUED, whatever the cursor', async () => {
    const assigned = await queue('assigned', { state: 'ASSIGNED', runnerId: 'r1', runnerBootId: 'boot-r1' });
    const queued = await queue('queued');

    expect((await repo.findQueuedPage(WORK, 50, null)).map((row) => row.id)).toEqual([queued.id]);
    expect((await repo.findQueuedPage(WORK, 50, null)).map((row) => row.id)).not.toContain(assigned.id);
  });

  it('places a newer job past a full page of jobs pinned to another runner', async () => {
    // The motivation for US-004: 50 candidates this runner can never take used to fill the whole window.
    await prisma.fleetJob.createMany({
      data: Array.from({ length: QUEUED_SCAN_LIMIT }, (_, i) => ({
        projectId, repoId, ref: 'main', command: 'RUN', feature: `pinned-away-${i}`, profiles: [], selectorLabels: [],
        maxCostUsd: new Prisma.Decimal(1), requestedById: requesterId, pinnedRunnerId: 'r2',
      })),
    });
    const newer = await queue('newer');

    expect(await fillAsRunner('r1', 1)).toBe(1);
    expect(await stateOf(newer.id)).toBe('ASSIGNED');
  });

  it('leaves a job past the page cap QUEUED for the next sync', async () => {
    // Exactly MAX_QUEUED_SCAN_PAGES full pages of candidates this runner always misfits on, then one it could take.
    const cap = MAX_QUEUED_SCAN_PAGES * QUEUED_SCAN_LIMIT;
    await prisma.fleetJob.createMany({
      data: Array.from({ length: cap }, (_, i) => ({
        projectId, repoId, ref: 'main', command: 'RUN', feature: `misfit-${i}`, profiles: [], selectorLabels: ['gpu'],
        maxCostUsd: new Prisma.Decimal(1), requestedById: requesterId,
      })),
    });
    const beyond = await queue('beyond-cap');

    expect(await fillAsRunner('r1', 1)).toBe(0);
    expect(await stateOf(beyond.id)).toBe('QUEUED');
  });

  it('does not place a QUEUED THREAD job from the work scan', async () => {
    const turn = await queue('turn', { command: 'THREAD', threadId: null });
    const work = await queue('work');

    expect(await fillAsRunner('r1', 2)).toBe(1);
    expect(await stateOf(work.id)).toBe('ASSIGNED');
    expect(await stateOf(turn.id)).toBe('QUEUED');
  });

  it('scans only THREAD jobs from the thread entry point', async () => {
    const work = await queue('work');
    // A THREAD job without its turn row is skipped rather than failing the sync, so the scan proves the filter
    // without a thread fixture: the work job is never even a candidate.
    await queue('turn', { command: 'THREAD', threadId: null });

    await fillThreadsAsRunner('r1');

    expect(await stateOf(work.id)).toBe('QUEUED');
  });
});
