import request from 'supertest';
import type { NathApplication } from '@nathapp/nestjs-app';
import { Prisma } from '../../../src/generated/prisma/client';
import { FLEET_CFG, type IFleetConfig } from '../../../src/config/fleet.config';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp } from '../../helpers/http-app';
import { fixtureDb } from '../../helpers/action-context';
import { FLEET_CAPS, seedFleetHttpWorld, type FleetHttpWorld } from '../../helpers/fleet-fixtures';
import { canRunDbTests } from '../../helpers/test-environment';

const describeDb = canRunDbTests() ? describe : describe.skip;

describeDb('thread queued turn detail verdict', () => {
  let app: NathApplication;
  let db: ReturnType<typeof fixtureDb>;
  let world: FleetHttpWorld;
  let seq = 0;
  const config = () => app.get<IFleetConfig>(FLEET_CFG);
  const get = (threadId: string) => request(app.getHttpServer()).get(`/api/projects/web/threads/${threadId}`).set({ Authorization: `Bearer ${world.tokens.dev}` });

  const queuedThread = async (queuedAt: Date) => {
    const runner = await db.runner.create({ data: {
      name: `queued-runner-${++seq}`, apiKeyHash: `queued-hash-${seq}`, os: 'linux', arch: 'x64', labels: [], capacity: 1,
      capabilities: { ...FLEET_CAPS, threadBackends: { native: ['some-other-model'], acp: [] } } as unknown as Prisma.InputJsonValue,
      daemonVersion: '0.1.0', protocolVersion: 4, bootId: `queued-boot-${seq}`, enabled: true, lastSeenAt: new Date(), createdById: world.ids.root,
    } });
    const thread = await db.chatThread.create({ data: {
      kind: 'REPO', projectId: world.projectId, repoId: world.repoId, baseRef: 'main', feature: `queued-${seq}`, specPath: 'spec.md',
      title: 'Queued turn', backend: { kind: 'native', model: 'requested-model' }, skills: [], createdById: world.ids.dev,
      createdByType: 'USER', mode: 'read', runnerId: runner.id,
    } });
    const job = await db.fleetJob.create({ data: {
      projectId: world.projectId, repoId: world.repoId, ref: 'main', command: 'THREAD', feature: `queued-job-${seq}`,
      profiles: [], maxCostUsd: 5, selectorLabels: [], requestedById: world.ids.dev, requestedByType: 'USER', threadId: thread.id,
      pinnedRunnerId: runner.id, queuedAt, state: 'QUEUED', leaseEpoch: 1,
    } });
    await db.fleetThreadTurn.create({ data: {
      jobId: job.id, threadId: thread.id, action: 'SESSION', instructions: '', backend: { kind: 'native', model: 'requested-model' },
      skills: [], resume: false,
    } });
    return { thread, runner };
  };

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    db = fixtureDb(app);
    world = await seedFleetHttpWorld(app.getHttpServer(), db);
    config().threadsEnabled = true;
    config().jobQueuedWarnSec = 60;
  }, 60_000);
  afterAll(async () => { await app?.close(); });

  it('AC-9: explains an old queued turn against its pinned runner', async () => {
    const { thread, runner } = await queuedThread(new Date(Date.now() - 120_000));
    const response = await get(thread.id).expect(200);
    expect(response.body.data.queuedTurn).toMatchObject({
      verdict: 'no_fit', reasons: [{ runnerName: runner.name, reason: 'thread_backend' }],
    });
    expect(response.body.data.queuedTurn.queuedAt).toEqual(expect.any(String));
  });

  it('AC-10: does not explain a turn younger than the warning threshold', async () => {
    const { thread } = await queuedThread(new Date());
    const response = await get(thread.id).expect(200);
    expect(response.body.data.queuedTurn).toBeNull();
  });
});
