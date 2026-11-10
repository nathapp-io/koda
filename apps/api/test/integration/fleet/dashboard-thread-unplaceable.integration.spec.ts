import { canRunDbTests } from '../../helpers/test-environment';
/**
 * Fleet #425 US-002 — the dashboard dry-run judges a queued THREAD job (PG).
 *
 * A queued THREAD job whose turn no runner can host is reported as `job_unplaceable` with the reason each
 * runner gave, so the thread page can explain why the turn waits.
 * Run: cd apps/api && bun run test:db:up && bun run test:scoped test/integration/fleet/dashboard-thread-unplaceable.integration.spec.ts
 */
import request from 'supertest';
import { NathApplication } from '@nathapp/nestjs-app';
import { Prisma, PrismaClient } from '../../../src/generated/prisma/client';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp, data } from '../../helpers/http-app';
import { FleetHttpWorld, insertRunner, seedFleetHttpWorld } from '../../helpers/fleet-fixtures';
import { PrismaDashboardRepository } from '../../../src/fleet/dashboard/prisma-dashboard.repository';
import { FLEET_CFG, IFleetConfig } from '../../../src/config/fleet.config';
import { expectGuardActive, fixtureDb } from '../../helpers/action-context';

// The nax sandbox withholds host Postgres/Docker.
const describeIntegration = canRunDbTests() ? describe : describe.skip;

interface Item {
  key: string;
  kind: string;
  severity: string;
  subjectId: string;
  verdict?: string;
  reasons?: Array<{ runnerName: string; reason: string }>;
}
interface Snapshot {
  attention: Item[];
}

describeIntegration('fleet dashboard explains a queued THREAD job (PG, US-002)', () => {
  let app: NathApplication;
  let server: ReturnType<NathApplication['getHttpServer']>;
  let prisma: PrismaClient;
  let repo: PrismaDashboardRepository;
  let world: FleetHttpWorld;
  let runnerId: string;
  let jobId: string;
  const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000);

  const cfg = () => app.get<IFleetConfig>(FLEET_CFG, { strict: false });

  const admin = async () => data<Snapshot>(await request(server).get('/api/fleet/dashboard')
    .set('Authorization', `Bearer ${world.tokens.root}`).expect(200));

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    server = app.getHttpServer();
    prisma = fixtureDb(app);
    world = await seedFleetHttpWorld(server, prisma);
    repo = app.get(PrismaDashboardRepository);
    // The thread kill switch is on: the turn waits for a runner, it is not switched off.
    cfg().threadsEnabled = true;
    // A protocol-4 runner that offers no thread backend at all, so the turn's backend is unhostable.
    runnerId = (await insertRunner(prisma, { name: 'thread-box', protocolVersion: 4, threadCapacity: 3 })).id;
    const thread = await prisma.chatThread.create({ data: {
      projectId: world.projectId, repoId: world.repoId, kind: 'REPO', feature: 'thread-turn', title: 'A thread',
      createdById: world.ids.root, backend: { kind: 'native', model: 'm1' }, skills: [],
    } });
    const job = await prisma.fleetJob.create({ data: {
      projectId: world.projectId, repoId: world.repoId, ref: 'main', command: 'THREAD', feature: 'thread-turn', profiles: [],
      maxCostUsd: new Prisma.Decimal(2), selectorLabels: [], requestedById: world.ids.root, state: 'QUEUED',
      queuedAt: minutesAgo(5), threadId: thread.id,
    } });
    jobId = job.id;
    await prisma.fleetThreadTurn.create({ data: {
      jobId: job.id, threadId: thread.id, action: 'SESSION', instructions: '', backend: { kind: 'native', model: 'm1' },
      skills: [], resume: false, mode: 'read',
    } });
  }, 30_000);

  afterAll(async () => {
    await app?.close();
  });

  it('writes need an action context', async () => {
    await expect(expectGuardActive(app)).resolves.toBeUndefined();
  });

  it('AC-12: a queued THREAD job no runner can host is reported as job_unplaceable', async () => {
    const snapshot = await admin();
    const item = snapshot.attention.find((a) => a.key === `job_unplaceable:${jobId}`);
    expect(item).toMatchObject({ kind: 'job_unplaceable', severity: 'warning', subjectId: jobId });
    expect(item?.reasons).toEqual([{ runnerName: 'thread-box', reason: 'thread_backend' }]);
  });

  it('AC-13: findRunners answers each runner\'s protocol version and thread capacity', async () => {
    const runners = await repo.findRunners();
    expect(runners.find((r) => r.id === runnerId)).toMatchObject({ name: 'thread-box', protocolVersion: 4, threadCapacity: 3 });
  });

  it('AC-14: findQueuedWindow answers the THREAD row\'s turn (backend, action, mode and thread kind)', async () => {
    const window = await repo.findQueuedWindow(50);
    const row = window.find((j) => j.id === jobId);
    expect(row?.command).toBe('THREAD');
    expect(row?.threadTurn).toEqual({ backend: { kind: 'native', model: 'm1' }, action: 'SESSION', kind: 'REPO', mode: 'read' });
  });
});
