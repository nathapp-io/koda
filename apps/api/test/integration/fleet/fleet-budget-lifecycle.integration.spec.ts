/* eslint-disable @typescript-eslint/no-non-null-assertion -- commands are asserted present before use */
/**
 * Fleet S1b slice 2a — budget-related job fields through the real sync path (PG).
 * Run: cd apps/api && bun run test:scoped test/integration/fleet/fleet-budget-lifecycle.integration.spec.ts
 */
import request from 'supertest';
import { NathApplication } from '@nathapp/nestjs-app';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { PrismaClient } from '../../../src/generated/prisma/client';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp, data } from '../../helpers/http-app';
import { enrollRunner, FleetHttpWorld, seedFleetHttpWorld, syncBody } from '../../helpers/fleet-fixtures';
import type { SyncRequest, SyncResponse } from '../../../src/fleet/common/protocol';

const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;

jest.setTimeout(20_000);

describeIntegration('fleet budget lifecycle fields (PG)', () => {
  let app: NathApplication;
  let server: ReturnType<NathApplication['getHttpServer']>;
  let prisma: PrismaClient;
  let world: FleetHttpWorld;
  let runner: { runnerId: string; apiKey: string };
  const saved = process.env.FLEET_SYNC_WAIT_MS;

  const sync = async (over: Partial<SyncRequest> = {}) =>
    data<SyncResponse>(await request(server).post('/api/fleet/runner/sync').set({ Authorization: `Bearer ${runner.apiKey}` }).send(syncBody(over)).expect(200));
  const dispatch = async (feature: string) =>
    data<{ job: { id: string; leaseEpoch: number } }>(
      await request(server).post('/api/projects/web/fleet/jobs').set({ Authorization: `Bearer ${world.tokens.dev}` })
        .send({ repoId: world.repoId, command: 'RUN', maxCostUsd: 5, feature }).expect(201),
    ).job;
  const job = (id: string) => prisma.fleetJob.findUniqueOrThrow({ where: { id } });
  const startRunning = async (feature: string) => {
    const j = await dispatch(feature);
    const assign = (await sync()).commands.find((c) => c.jobId === j.id && c.type === 'ASSIGN')!;
    await sync({
      commandAcks: [{ commandId: assign.commandId, leaseEpoch: j.leaseEpoch, result: 'ok' }],
      jobs: [{ jobId: j.id, leaseEpoch: j.leaseEpoch, events: [{ seq: 1, type: 'state', payload: { to: 'RUNNING' } }] }],
    });
    return j;
  };
  // The runner has capacity 1: free it between cases so each dispatch is assigned at once.
  const finishAll = () => prisma.fleetJob.updateMany({ where: { state: { in: ['ASSIGNED', 'RUNNING', 'UPLOADING'] } }, data: { state: 'COMPLETED' } });

  beforeAll(async () => {
    process.env.FLEET_SYNC_WAIT_MS = '200';
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    server = app.getHttpServer();
    prisma = app.get<PrismaService<PrismaClient>>(PrismaService).client;
    world = await seedFleetHttpWorld(server, prisma);
    runner = await enrollRunner(server, world.tokens.root, 'box-1');
  });
  afterEach(async () => {
    await finishAll();
  });
  afterAll(async () => {
    await app.close();
    if (saved === undefined) delete process.env.FLEET_SYNC_WAIT_MS;
    else process.env.FLEET_SYNC_WAIT_MS = saved;
  });

  it('stamps firstStartedAt when the runner reports RUNNING', async () => {
    const j = await startRunning('first-start');
    const row = await job(j.id);
    expect(row.state).toBe('RUNNING');
    expect(row.firstStartedAt).not.toBeNull();
    expect(row.firstStartedAt).toEqual(row.startedAt);
  });

  it('uses the server cancelReason as the final stateReason when the runner reports CANCELLED (plan D156)', async () => {
    const j = await startRunning('cancel-reason');
    await prisma.fleetJob.update({ where: { id: j.id }, data: { cancelReason: 'budget:pol-1', cancelRequestedAt: new Date() } });
    await sync({ jobs: [{ jobId: j.id, leaseEpoch: j.leaseEpoch, events: [{ seq: 2, type: 'state', payload: { to: 'CANCELLED', reason: null } }] }] });
    expect(await job(j.id)).toEqual(expect.objectContaining({ state: 'CANCELLED', stateReason: 'budget:pol-1' }));
  });

  it('keeps the runner reason for a cancel without a server reason', async () => {
    const j = await startRunning('cancel-plain');
    await sync({ jobs: [{ jobId: j.id, leaseEpoch: j.leaseEpoch, events: [{ seq: 2, type: 'state', payload: { to: 'CANCELLED', reason: 'cancelled before start' } }] }] });
    expect(await job(j.id)).toEqual(expect.objectContaining({ state: 'CANCELLED', stateReason: 'cancelled before start' }));
  });
});
