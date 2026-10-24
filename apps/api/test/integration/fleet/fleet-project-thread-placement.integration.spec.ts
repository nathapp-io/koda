/**
 * Fleet S5b US-005 — PROJECT ASSIGN and placement (PG): a PROJECT thread's THREAD job is assigned only to a runner
 * that advertises `projectThreads` (S5b-R9), and its ASSIGN names the thread kind — `PROJECT` — with the job's own
 * `thread-<threadId>` feature on the anchor repo (1a-R1). Both placement entry points are covered: the send's
 * `PlacementService.placeJob` (AC-6) and the runner sync's `fillRunnerThreads` (AC-1..AC-5, AC-7). A REPO thread
 * (AC-4, AC-5) keeps its own feature and is unaffected by the new capability.
 *
 * Acceptance setup: FLEET_THREADS_ENABLED=true and FLEET_SYNC_WAIT_MS=0 before boot, `dev` (DEVELOPER) is the thread
 * creator, requests as dev, capability reports posted through POST /api/fleet/runner/sync (SEAM-1).
 * Run: cd apps/api && bun run test:db:up && bun run test:scoped test/integration/fleet/fleet-project-thread-placement.integration.spec.ts
 */
import request from 'supertest';
import { NathApplication } from '@nathapp/nestjs-app';
import { PrismaClient } from '../../../src/generated/prisma/client';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp, data } from '../../helpers/http-app';
import { enrollRunner, FLEET_CAPS, FleetHttpWorld, seedFleetHttpWorld, syncBody } from '../../helpers/fleet-fixtures';
import { expectBindingOnlyFixtures, grantRole } from '../../../src/permissions/test-helpers/permission-fixtures';
import type { AssignPayload, RunnerCapabilities, SyncRequest, SyncResponse } from '../../../src/fleet/common/protocol';
import { expectGuardActive, fixtureDb } from '../../helpers/action-context';

const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;
vi.setConfig({ testTimeout: 20_000 });

/** A runner whose lastSeenAt predates any placement window: offline for every test that does not enroll one. */
const OFFLINE_AT = new Date('2020-01-01T00:00:00.000Z');

/** The FLEET_CAPS report plus the thread capabilities a v4 runner advertises; `projectThreads` is opt-in. */
const threadCaps = (over: Partial<RunnerCapabilities> = {}): RunnerCapabilities => ({
  ...FLEET_CAPS,
  threadBackends: { native: ['m1'], acp: [] },
  threadWrite: true,
  ...over,
});

interface AnchorProject {
  slug: string;
  anchorRepoName: string;
  laterRepoName: string;
}

describeIntegration('fleet project thread placement (PG, US-005)', () => {
  let app: NathApplication;
  let server: ReturnType<NathApplication['getHttpServer']>;
  let prisma: PrismaClient;
  let world: FleetHttpWorld;
  let seq = 0;
  const saved: Record<string, string | undefined> = {};

  const asDev = () => ({ Authorization: `Bearer ${world.tokens.dev}` });

  const sync = async (apiKey: string, over: Partial<SyncRequest> = {}) =>
    data<SyncResponse>(await request(server).post('/api/fleet/runner/sync').set({ Authorization: `Bearer ${apiKey}` })
      .send(syncBody({ protocolVersion: 4, bootId: 'boot-1', freeSlots: 0, ...over })).expect(200));

  /** Every runner row offline. Each test enrolls the one runner it means to be eligible. */
  const offlineAllRunners = () => prisma.runner.updateMany({ data: { lastSeenAt: OFFLINE_AT } });

  const seedProject = async (prefix: string, key: string) => {
    const slug = `${prefix}-${++seq}`;
    const project = await prisma.project.create({ data: { name: slug, slug, key: `${key}${seq}` } });
    await grantRole(prisma, { type: 'USER', id: world.ids.dev }, 'developer', project.id);
    return project;
  };

  const seedRepo = (projectId: string, name: string, defaultBranch: string, createdAt: Date) =>
    prisma.fleetRepo.create({ data: {
      projectId, provider: 'github', owner: 'acme', name, defaultBranch, createdById: world.ids.root, createdAt,
    } });

  /**
   * A project with two fleet repos and `dev` as DEVELOPER. The later repo is written first, so insertion order cannot
   * stand in for the anchor rule: the anchor is the older `createdAt`, not the first row.
   */
  const seedTwoRepoProject = async (): Promise<AnchorProject> => {
    const project = await seedProject('anchor', 'A');
    const laterRepoName = `later-${seq}`;
    const anchorRepoName = `anchor-${seq}`;
    await seedRepo(project.id, laterRepoName, 'develop', new Date('2026-02-02T00:00:00.000Z'));
    await seedRepo(project.id, anchorRepoName, 'trunk', new Date('2026-02-01T00:00:00.000Z'));
    return { slug: project.slug, anchorRepoName, laterRepoName };
  };

  const createProjectThread = async (slug: string, title: string): Promise<string> =>
    data<{ id: string }>(await request(server).post(`/api/projects/${slug}/threads`).set(asDev())
      .send({ kind: 'PROJECT', title, backend: { kind: 'native', model: 'm1' } }).expect(201)).id;

  const createRepoThread = async (feature: string): Promise<string> =>
    data<{ id: string }>(await request(server).post('/api/projects/web/threads').set(asDev())
      .send({ repoId: world.repoId, feature, title: 'Repo placement', backend: { kind: 'native', model: 'm1' } }).expect(201)).id;

  const send = (slug: string, id: string, clientMessageId: string) =>
    request(server).post(`/api/projects/${slug}/threads/${id}/messages`).set(asDev())
      .send({ text: 'Which tickets are blocked?', clientMessageId });

  const jobOfThread = (threadId: string) =>
    prisma.fleetJob.findFirstOrThrow({ where: { threadId, command: 'THREAD' }, orderBy: { queuedAt: 'desc' } });

  const assignOf = (res: SyncResponse, jobId: string) => {
    const command = res.commands.find((c) => c.type === 'ASSIGN' && c.jobId === jobId);
    expect(command).toBeDefined();
    return command?.payload as AssignPayload;
  };

  beforeAll(async () => {
    for (const key of ['FLEET_THREADS_ENABLED', 'FLEET_SYNC_WAIT_MS']) saved[key] = process.env[key];
    process.env['FLEET_THREADS_ENABLED'] = 'true';
    process.env['FLEET_SYNC_WAIT_MS'] = '0';
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    server = app.getHttpServer();
    prisma = fixtureDb(app);
    world = await seedFleetHttpWorld(server, prisma);
  }, 30_000);

  beforeEach(async () => {
    await offlineAllRunners();
  });

  afterAll(async () => {
    try {
      await app?.close();
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it('writes need an action context', async () => {
    await expect(expectGuardActive(app)).resolves.toBeUndefined();
  });

  it('fixtures grant through bindings only', async () => {
    await expectBindingOnlyFixtures(prisma, [
      { type: 'USER', id: world.ids.root },
      { type: 'USER', id: world.ids.dev },
      { type: 'USER', id: world.ids.viewer },
      { type: 'USER', id: world.ids.outsider },
    ]);
  });

  it('AC-1/AC-2: a PROJECT send then a protocol-4 sync with projectThreads returns the PROJECT ASSIGN', async () => {
    const project = await seedTwoRepoProject();
    const threadId = await createProjectThread(project.slug, 'Blocked tickets');
    const runner = await enrollRunner(server, world.tokens.root, `proj-assign-${++seq}`, { capabilities: threadCaps() });
    await send(project.slug, threadId, `cm-${++seq}`).expect(201);
    const job = await jobOfThread(threadId);
    // The enrolled runner is still at protocol 1, so the send's placeJob cannot host the job (SEAM-4 AC-6).
    expect(job.state).toBe('QUEUED');

    const res = await sync(runner.apiKey, { capabilities: threadCaps({ projectThreads: true }) });

    const payload = assignOf(res, job.id);
    expect(payload.thread).toMatchObject({ threadId, kind: 'PROJECT', action: 'SESSION' });
    // AC-2 (1a-R1): a PROJECT thread has no feature of its own, so the ASSIGN carries the job's own name.
    expect((payload.thread as { feature: string }).feature).toBe(`thread-${threadId}`);
  });

  it('AC-3: that ASSIGN names the anchor repo (the project oldest fleet repo)', async () => {
    const project = await seedTwoRepoProject();
    const threadId = await createProjectThread(project.slug, 'Anchor repo');
    const runner = await enrollRunner(server, world.tokens.root, `proj-anchor-${++seq}`, { capabilities: threadCaps() });
    await send(project.slug, threadId, `cm-${++seq}`).expect(201);
    const job = await jobOfThread(threadId);

    const res = await sync(runner.apiKey, { capabilities: threadCaps({ projectThreads: true }) });

    const payload = assignOf(res, job.id);
    expect(payload.repo).toMatchObject({ owner: 'acme', name: project.anchorRepoName });
    expect(payload.repo.name).not.toBe(project.laterRepoName);
  });

  it('AC-4/AC-5: a REPO thread send then the same sync returns a REPO ASSIGN with the thread feature', async () => {
    const feature = `repo-placement-${++seq}`;
    const threadId = await createRepoThread(feature);
    const runner = await enrollRunner(server, world.tokens.root, `repo-assign-${++seq}`, { capabilities: threadCaps() });
    await send('web', threadId, `cm-${++seq}`).expect(201);
    const job = await jobOfThread(threadId);

    const res = await sync(runner.apiKey, { capabilities: threadCaps({ projectThreads: true }) });

    const payload = assignOf(res, job.id);
    expect(payload.thread).toMatchObject({ threadId, kind: 'REPO' });
    expect((payload.thread as { feature: string }).feature).toBe(feature);
  });

  it('AC-6: a PROJECT send with only a backends runner without projectThreads (placeJob) leaves the job QUEUED', async () => {
    const project = await seedTwoRepoProject();
    const runner = await enrollRunner(server, world.tokens.root, `no-project-threads-${++seq}`);
    // A real capability report: protocol 4, thread backends, no projectThreads.
    await sync(runner.apiKey, { capabilities: threadCaps() });
    const threadId = await createProjectThread(project.slug, 'No projectThreads');

    await send(project.slug, threadId, `cm-${++seq}`).expect(201);

    const job = await jobOfThread(threadId);
    expect(job).toMatchObject({ state: 'QUEUED', runnerId: null, pinnedRunnerId: null });
    expect(await prisma.fleetCommand.count({ where: { jobId: job.id, type: 'ASSIGN' } })).toBe(0);
  });

  it('AC-7: a PROJECT send with no runner online then a sync without projectThreads (fillRunnerThreads) assigns nothing', async () => {
    const project = await seedTwoRepoProject();
    const threadId = await createProjectThread(project.slug, 'No runner online');
    const onlineBefore = await prisma.runner.findMany({ select: { lastSeenAt: true } });
    expect(onlineBefore.every((r) => r.lastSeenAt.getTime() === OFFLINE_AT.getTime())).toBe(true);
    await send(project.slug, threadId, `cm-${++seq}`).expect(201);
    const job = await jobOfThread(threadId);
    expect(job.state).toBe('QUEUED');

    const runner = await enrollRunner(server, world.tokens.root, `sync-no-project-threads-${++seq}`);
    const res = await sync(runner.apiKey, { capabilities: threadCaps() });

    expect(res.commands.filter((c) => c.type === 'ASSIGN')).toEqual([]);
    expect((await jobOfThread(threadId)).state).toBe('QUEUED');
  });
});
