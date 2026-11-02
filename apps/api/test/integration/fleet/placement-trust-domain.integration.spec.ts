import { canRunDbTests } from '../../helpers/test-environment';
/**
 * US-004 — trust-domain placement plumbing (PG): the load a runner really holds, the dispatch of
 * `POST /api/projects/:slug/fleet/jobs` and the fill of `POST /api/fleet/runner/sync`.
 * Run: cd apps/api && bun run test:scoped test/integration/fleet/placement-trust-domain.integration.spec.ts
 */
import request from 'supertest';
import { NathApplication } from '@nathapp/nestjs-app';
import { Prisma, PrismaClient } from '../../../src/generated/prisma/client';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp, data } from '../../helpers/http-app';
import { enrollRunner, FleetHttpWorld, insertRunner, seedFleetHttpWorld, syncBody } from '../../helpers/fleet-fixtures';
import { PrismaFleetJobRepository } from '../../../src/fleet/jobs/prisma-fleet-job.repository';
import type { SyncResponse } from '../../../src/fleet/common/protocol';
import { expectGuardActive, fixtureDb } from '../../helpers/action-context';

// The nax sandbox withholds host Postgres/Docker.
const describeIntegration = canRunDbTests() ? describe : describe.skip;

describeIntegration('fleet placement trust domains (PG)', () => {
  let app: NathApplication;
  let server: ReturnType<NathApplication['getHttpServer']>;
  let prisma: PrismaClient;
  let jobs: PrismaFleetJobRepository;
  let world: FleetHttpWorld;
  const savedSyncWait = process.env.FLEET_SYNC_WAIT_MS;

  /** A QUEUED raw RUN job of `projectId` on `repoId`: the shape both placement entry points scan. */
  const queue = (projectId: string, repoId: string, feature: string) => prisma.fleetJob.create({
    data: {
      projectId, repoId, ref: 'trunk', command: 'RUN', feature, profiles: ['fast'],
      maxCostUsd: new Prisma.Decimal(5), selectorLabels: [], bashMode: 'raw', requestedById: world.ids.dev,
    },
  });
  /** The same job as a runner already holds it: a raw RUN of the other project, RUNNING on that runner. */
  const hold = (runnerId: string, projectId: string, repoId: string, feature: string) => prisma.fleetJob.create({
    data: {
      projectId, repoId, ref: 'trunk', command: 'RUN', feature, profiles: ['fast'],
      maxCostUsd: new Prisma.Decimal(5), selectorLabels: [], bashMode: 'raw', requestedById: world.ids.dev,
      state: 'RUNNING', runnerId, runnerBootId: 'boot-1', leaseEpoch: 1, assignedAt: new Date(), startedAt: new Date(),
    },
  });
  const stateOf = async (id: string) => (await prisma.fleetJob.findUniqueOrThrow({ where: { id } })).state;
  /** An enrolled runner with a usable key, and the capacity the story needs. */
  const enrolled = async (name: string, capacity: number) => {
    const runner = await enrollRunner(server, world.tokens.root, name);
    await prisma.runner.update({ where: { id: runner.runnerId }, data: { capacity } });
    return runner;
  };
  const sync = async (apiKey: string) =>
    data<SyncResponse>(await request(server).post('/api/fleet/runner/sync').set({ Authorization: `Bearer ${apiKey}` }).send(syncBody({ freeSlots: 2 })).expect(200));
  /** A raw RUN dispatch into project `ops` (the other trust domain), through the real project route. */
  const dispatchRaw = async (feature: string) => data<{
    job: { id: string; state: string };
    placement: { assigned: boolean; misfits: Array<{ runnerId: string; name: string; reason: string }> };
  }>(await request(server).post('/api/projects/ops/fleet/jobs').set({ Authorization: `Bearer ${world.tokens.root}` })
    .send({ repoId: world.foreignRepoId, command: 'RUN', maxCostUsd: 5, feature }).expect(201));

  beforeAll(async () => {
    process.env.FLEET_SYNC_WAIT_MS = '0';
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    server = app.getHttpServer();
    prisma = fixtureDb(app);
    jobs = app.get(PrismaFleetJobRepository);
    world = await seedFleetHttpWorld(server, prisma);
  });
  afterAll(async () => {
    await app.close();
    if (savedSyncWait === undefined) delete process.env.FLEET_SYNC_WAIT_MS;
    else process.env.FLEET_SYNC_WAIT_MS = savedSyncWait;
  });
  beforeEach(async () => {
    await prisma.fleetCommand.deleteMany();
    await prisma.fleetJob.deleteMany();
    await prisma.runner.deleteMany();
  });

  it('writes need an action context', async () => {
    await expect(expectGuardActive(app)).resolves.toBeUndefined();
  });

  it('US-004 AC-2: findActiveLoads carries the held job projectId and bashMode', async () => {
    const runner = await insertRunner(prisma, { capacity: 2 });
    const held = await hold(runner.id, world.projectId, world.repoId, 'ac2-held');
    expect(await jobs.findActiveLoads([runner.id])).toEqual([
      { runnerId: runner.id, repoId: world.repoId, command: 'RUN', projectId: world.projectId, bashMode: 'raw' },
    ]);
    expect(held.id).toBeDefined();
  });

  it('US-004 AC-3: a dispatch of project B stays QUEUED when the runner holds raw work of project A', async () => {
    const runner = await insertRunner(prisma, { capacity: 2 });
    await hold(runner.id, world.projectId, world.repoId, 'ac3-held');

    const result = await dispatchRaw('ac3-other-project');

    expect(result.job.state).toBe('QUEUED');
    expect(result.placement.assigned).toBe(false);
    expect(await stateOf(result.job.id)).toBe('QUEUED');
  });

  it('US-004 AC-4: the same dispatch answers a misfit naming that runner with reason trust_domain', async () => {
    const runner = await insertRunner(prisma, { capacity: 2 });
    await hold(runner.id, world.projectId, world.repoId, 'ac4-held');

    const result = await dispatchRaw('ac4-other-project');

    expect(result.placement.misfits).toEqual([{ runnerId: runner.id, name: expect.any(String), reason: 'trust_domain' }]);
  });

  it('US-004 AC-5: one sync of a free runner leaves exactly one of two raw jobs from different projects ASSIGNED', async () => {
    const runner = await enrolled('trust-sync', 2);
    const a = await queue(world.projectId, world.repoId, 'ac5-a');
    const b = await queue(world.opsProjectId, world.foreignRepoId, 'ac5-b');

    const res = await sync(runner.apiKey);
    const assignedIds = res.commands.filter((c) => c.type === 'ASSIGN').map((c) => c.jobId);

    expect(assignedIds).toHaveLength(1);
    const states = await Promise.all([stateOf(a.id), stateOf(b.id)]);
    expect(states.filter((s) => s === 'ASSIGNED')).toHaveLength(1);
    const held = await prisma.fleetJob.findFirstOrThrow({ where: { state: 'ASSIGNED' } });
    expect(held.runnerId).toBe(runner.runnerId);
    expect(held.id).toBe(assignedIds[0]);
  });

  it('US-004 AC-6: the other job of that sync stays QUEUED while its sibling is ASSIGNED to that runner', async () => {
    const runner = await enrolled('trust-sync-queued', 2);
    const a = await queue(world.projectId, world.repoId, 'ac6-a');
    const b = await queue(world.opsProjectId, world.foreignRepoId, 'ac6-b');

    await sync(runner.apiKey);

    const pairs = [[a.id, await stateOf(a.id)], [b.id, await stateOf(b.id)]] as const;
    const queued = pairs.filter(([, state]) => state === 'QUEUED');
    const assigned = pairs.filter(([, state]) => state === 'ASSIGNED');
    expect(queued).toHaveLength(1);
    expect(assigned).toHaveLength(1);
    const assignedJob = await prisma.fleetJob.findUniqueOrThrow({ where: { id: assigned[0][0] } });
    expect(assignedJob.runnerId).toBe(runner.runnerId);
    expect((await prisma.fleetJob.findUniqueOrThrow({ where: { id: queued[0][0] } })).runnerId).toBeNull();
  });

  it('US-004 AC-7: one sync places both raw jobs of the same project when they sit on distinct repos', async () => {
    const runner = await enrolled('trust-same-project', 2);
    const second = await prisma.fleetRepo.create({
      data: {
        projectId: world.projectId, provider: 'github', owner: 'acme', name: 'app-second', defaultBranch: 'trunk',
        githubInstallationId: BigInt(77), createdById: world.ids.root,
      },
    });
    const a = await queue(world.projectId, world.repoId, 'ac7-a');
    const b = await queue(world.projectId, second.id, 'ac7-b');

    const res = await sync(runner.apiKey);
    expect(res.commands.filter((c) => c.type === 'ASSIGN').map((c) => c.jobId).sort()).toEqual([a.id, b.id].sort());
    expect([await stateOf(a.id), await stateOf(b.id)]).toEqual(['ASSIGNED', 'ASSIGNED']);
    expect(await prisma.fleetJob.count({ where: { runnerId: runner.runnerId, state: 'ASSIGNED' } })).toBe(2);
  });
});
