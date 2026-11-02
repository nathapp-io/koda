import { canRunDbTests } from '../../helpers/test-environment';
import request from 'supertest';
import { NathApplication } from '@nathapp/nestjs-app';
import { Prisma, PrismaClient } from '../../../src/generated/prisma/client';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp, data } from '../../helpers/http-app';
import { enrollRunner, FleetHttpWorld, FLEET_CAPS, seedFleetHttpWorld, syncBody } from '../../helpers/fleet-fixtures';
import { PrismaFleetJobRepository } from '../../../src/fleet/jobs/prisma-fleet-job.repository';
import type { SyncResponse } from '../../../src/fleet/common/protocol';
import { fixtureDb } from '../../helpers/action-context';

const describeIntegration = canRunDbTests() ? describe : describe.skip;

describeIntegration('FIX assignment detected-check trust (PG)', () => {
  let app: NathApplication;
  let server: ReturnType<NathApplication['getHttpServer']>;
  let prisma: PrismaClient;
  let world: FleetHttpWorld;
  let runner: { runnerId: string; apiKey: string };
  let jobs: PrismaFleetJobRepository;
  const previousSyncWait = process.env.FLEET_SYNC_WAIT_MS;

  const sync = async (freeSlots = 1) => data<SyncResponse>(await request(server).post('/api/fleet/runner/sync')
    .set({ Authorization: `Bearer ${runner.apiKey}` }).send(syncBody({ freeSlots })).expect(200));
  const dispatch = async (prNumber: number) => data<{ job: { id: string; state: string } }>(await request(server)
    .post('/api/projects/web/fleet/jobs').set({ Authorization: `Bearer ${world.tokens.dev}` })
    .send({ command: 'FIX', repoId: world.repoId, prNumber, maxCostUsd: 1 }).expect(201));
  const assignFor = async (jobId: string) => prisma.fleetCommand.findMany({ where: { jobId, type: 'ASSIGN' } });

  beforeAll(async () => {
    process.env.FLEET_SYNC_WAIT_MS = '0';
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    server = app.getHttpServer();
    prisma = fixtureDb(app);
    jobs = app.get(PrismaFleetJobRepository);
    world = await seedFleetHttpWorld(server, prisma);
    runner = await enrollRunner(server, world.tokens.root, 'fix-trust-runner', {
      capabilities: { ...FLEET_CAPS, botReview: true, botFix: true },
    });
  });
  afterAll(async () => {
    await app?.close();
    if (previousSyncWait === undefined) delete process.env.FLEET_SYNC_WAIT_MS;
    else process.env.FLEET_SYNC_WAIT_MS = previousSyncWait;
  });
  beforeEach(async () => {
    await prisma.fleetCommand.deleteMany();
    await prisma.fleetJob.deleteMany();
    await prisma.runner.update({ where: { id: runner.runnerId }, data: { capacity: 4 } });
  });

  it('AC-5: findRepo reads true and the persisted default false', async () => {
    // Do not reuse world.repoId: the dispatch cases mutate its setting. Omitting the setting on a
    // fresh row keeps this a database-default assertion even when cases run in shuffled order.
    const target = await prisma.fleetRepo.create({ data: {
      projectId: world.projectId, provider: 'github', owner: 'acme', name: 'fix-trust-default', defaultBranch: 'main',
      githubInstallationId: BigInt(77), createdById: world.ids.root,
    } });
    expect(await jobs.findRepo(target.id)).toEqual(expect.objectContaining({ fixTrustDetectedChecks: false }));
    await prisma.fleetRepo.update({ where: { id: target.id }, data: { fixTrustDetectedChecks: true } });
    expect(await jobs.findRepo(target.id)).toEqual(expect.objectContaining({ fixTrustDetectedChecks: true }));
  });

  it('AC-6: dispatch stores true in the actual ASSIGN command for an enabled FIX repo', async () => {
    await prisma.fleetRepo.update({ where: { id: world.repoId }, data: { fixTrustDetectedChecks: true } });
    const result = await dispatch(61);
    expect(result.job.state).toBe('ASSIGNED');
    const commands = await assignFor(result.job.id);
    expect(commands).toHaveLength(1);
    expect(commands[0].payload).toMatchObject({ review: { prNumber: 61, trustDetectedChecks: true } });
  });

  it('AC-7: false repo setting is absent from the actual ASSIGN command', async () => {
    await prisma.fleetRepo.update({ where: { id: world.repoId }, data: { fixTrustDetectedChecks: false } });
    const result = await dispatch(62);
    const commands = await assignFor(result.job.id);
    expect(commands).toHaveLength(1);
    expect(commands[0].payload).toHaveProperty('review');
    expect(commands[0].payload).not.toHaveProperty('review.trustDetectedChecks');
  });

  it('AC-8: a queued FIX observes the setting change when runner sync fills the slot', async () => {
    await prisma.runner.update({ where: { id: runner.runnerId }, data: { capacity: 1 } });
    const busyRepo = await prisma.fleetRepo.create({ data: {
      projectId: world.projectId, provider: 'github', owner: 'acme', name: 'busy', defaultBranch: 'main',
      githubInstallationId: BigInt(77), createdById: world.ids.root,
    } });
    await prisma.fleetJob.create({ data: {
      projectId: world.projectId, repoId: busyRepo.id, ref: 'main', command: 'RUN', feature: 'occupy-slot', profiles: [],
      maxCostUsd: new Prisma.Decimal(1), selectorLabels: [], requestedById: world.ids.dev, state: 'RUNNING',
      runnerId: runner.runnerId, runnerBootId: 'boot-1', leaseEpoch: 1, assignedAt: new Date(), startedAt: new Date(),
    } });
    await prisma.fleetRepo.update({ where: { id: world.repoId }, data: { fixTrustDetectedChecks: true } });
    const result = await dispatch(63);
    expect(result.job.state).toBe('QUEUED');
    expect(await assignFor(result.job.id)).toHaveLength(0);

    await prisma.fleetRepo.update({ where: { id: world.repoId }, data: { fixTrustDetectedChecks: false } });
    await prisma.fleetJob.updateMany({ where: { repoId: busyRepo.id }, data: { state: 'COMPLETED' } });
    const response = await sync(1);
    expect(response.commands.filter((command) => command.type === 'ASSIGN' && command.jobId === result.job.id)).toHaveLength(1);
    const commands = await assignFor(result.job.id);
    expect(commands).toHaveLength(1);
    expect(commands[0].payload).not.toHaveProperty('review.trustDetectedChecks');
  });
});
