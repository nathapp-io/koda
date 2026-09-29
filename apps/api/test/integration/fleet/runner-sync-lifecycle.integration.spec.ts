/* eslint-disable @typescript-eslint/no-non-null-assertion -- the brief's test code asserts presence with toBeDefined and then uses ! */
/**
 * Fleet S1 slice 2 — sync lifecycle: acks, cancel races, reboot readopt, long-poll wake-up (PG).
 * Run: cd apps/api && bun run test:scoped test/integration/fleet/runner-sync-lifecycle.integration.spec.ts
 */
import request from 'supertest';
import { NathApplication } from '@nathapp/nestjs-app';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { PrismaClient } from '@prisma/client';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp, data } from '../../helpers/http-app';
import { enrollRunner, FleetHttpWorld, seedFleetHttpWorld, syncBody } from '../../helpers/fleet-fixtures';
import type { SyncRequest, SyncResponse } from '../../../src/fleet/common/protocol';

const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;

jest.setTimeout(20_000); // several syncs here return idle and wait the full FLEET_SYNC_WAIT_MS

describeIntegration('runner sync lifecycle (PG)', () => {
  let app: NathApplication;
  let server: ReturnType<NathApplication['getHttpServer']>;
  let prisma: PrismaClient;
  let world: FleetHttpWorld;
  let runner: { runnerId: string; apiKey: string };
  const saved = process.env.FLEET_SYNC_WAIT_MS;

  const sync = async (over: Partial<SyncRequest> = {}) =>
    data<SyncResponse>(await request(server).post('/api/fleet/runner/sync').set({ Authorization: `Bearer ${runner.apiKey}` }).send(syncBody(over)).expect(200));
  const asDev = () => ({ Authorization: `Bearer ${world.tokens.dev}` });
  const dispatch = async (feature: string, repoId = world.repoId) =>
    data<{ job: { id: string; leaseEpoch: number } }>(
      await request(server).post('/api/projects/web/fleet/jobs').set(asDev()).send({ repoId, command: 'RUN', maxCostUsd: 5, feature }).expect(201),
    ).job;
  const job = (id: string) => prisma.fleetJob.findUniqueOrThrow({ where: { id } });
  /** Dispatch, take the ASSIGN, ack it and report RUNNING. */
  const startRunning = async (feature: string, repoId = world.repoId) => {
    const j = await dispatch(feature, repoId);
    const assign = (await sync()).commands.find((c) => c.jobId === j.id && c.type === 'ASSIGN')!;
    await sync({
      commandAcks: [{ commandId: assign.commandId, leaseEpoch: j.leaseEpoch, result: 'ok' }],
      jobs: [{ jobId: j.id, leaseEpoch: j.leaseEpoch, events: [{ seq: 1, type: 'state', payload: { to: 'RUNNING' } }] }],
    });
    return j;
  };
  const finishAll = () => prisma.fleetJob.updateMany({ where: { state: { in: ['ASSIGNED', 'RUNNING', 'UPLOADING'] } }, data: { state: 'COMPLETED' } });

  beforeAll(async () => {
    process.env.FLEET_SYNC_WAIT_MS = '800';
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    server = app.getHttpServer();
    prisma = app.get<PrismaService<PrismaClient>>(PrismaService).client;
    world = await seedFleetHttpWorld(server, prisma);
    runner = await enrollRunner(server, world.tokens.root, 'box-1');
  });
  afterAll(async () => {
    await app.close();
    if (saved === undefined) delete process.env.FLEET_SYNC_WAIT_MS;
    else process.env.FLEET_SYNC_WAIT_MS = saved;
  });
  afterEach(async () => {
    await finishAll();
  });

  it('fails a job whose ASSIGN the runner rejects', async () => {
    const j = await dispatch('rejected');
    const assign = (await sync()).commands.find((c) => c.jobId === j.id)!;
    await sync({ commandAcks: [{ commandId: assign.commandId, leaseEpoch: j.leaseEpoch, result: 'rejected', detail: 'workspace root full' }] });
    expect(await job(j.id)).toEqual(expect.objectContaining({ state: 'FAILED', stateReason: 'assign rejected: workspace root full' }));
  });

  it('delivers CANCEL for a running job and ends CANCELLED when the runner reports it', async () => {
    const j = await startRunning('cancel');
    await request(server).post(`/api/projects/web/fleet/jobs/${j.id}/cancel`).set(asDev()).expect(200);
    const cancel = (await sync()).commands.find((c) => c.jobId === j.id && c.type === 'CANCEL')!;
    await sync({
      commandAcks: [{ commandId: cancel.commandId, leaseEpoch: j.leaseEpoch, result: 'ok' }],
      jobs: [{ jobId: j.id, leaseEpoch: j.leaseEpoch, events: [{ seq: 2, type: 'state', payload: { to: 'CANCELLED' } }] }],
    });
    expect((await job(j.id)).state).toBe('CANCELLED');
  });

  it('lets a terminal report beat a pending CANCEL; the late ack is harmless (review focus 4)', async () => {
    const j = await startRunning('race');
    await request(server).post(`/api/projects/web/fleet/jobs/${j.id}/cancel`).set(asDev()).expect(200);
    const cancel = (await sync()).commands.find((c) => c.jobId === j.id && c.type === 'CANCEL')!;
    await sync({ jobs: [{ jobId: j.id, leaseEpoch: j.leaseEpoch, events: [
      { seq: 2, type: 'state', payload: { to: 'UPLOADING' } }, { seq: 3, type: 'state', payload: { to: 'COMPLETED' } },
    ] }] });
    expect((await job(j.id)).state).toBe('COMPLETED');
    expect((await prisma.fleetCommand.findUniqueOrThrow({ where: { id: cancel.commandId } })).ackResult).toBe('withdrawn');
    await sync({ commandAcks: [{ commandId: cancel.commandId, leaseEpoch: j.leaseEpoch, result: 'ok' }] });
    expect((await job(j.id)).state).toBe('COMPLETED');
  });

  it('queues one READOPT per held job on a new boot id; ok re-adopts, rejected crashes (review focus 3)', async () => {
    const keep = await startRunning('readopt-ok');
    await prisma.runner.update({ where: { id: runner.runnerId }, data: { capacity: 2 } });
    // Placement never puts two active jobs of one repo on one runner (busy_repo), so use a second repo.
    const repo2 = await prisma.fleetRepo.create({
      data: { projectId: world.projectId, provider: 'github', owner: 'acme', name: 'app2', defaultBranch: 'main', githubInstallationId: BigInt(77), createdById: world.ids.root },
    });
    const lose = await startRunning('readopt-lost', repo2.id);
    const r1 = await sync({ bootId: 'boot-2' });
    const readopts = r1.commands.filter((c) => c.type === 'READOPT');
    expect(readopts.map((c) => c.jobId).sort()).toEqual([keep.id, lose.id].sort());
    await sync({ bootId: 'boot-2' });
    expect(await prisma.fleetCommand.count({ where: { type: 'READOPT' } })).toBe(2);

    const byJob = new Map(readopts.map((c) => [c.jobId, c]));
    await sync({ bootId: 'boot-2', commandAcks: [
      { commandId: byJob.get(keep.id)!.commandId, leaseEpoch: keep.leaseEpoch, result: 'ok' },
      { commandId: byJob.get(lose.id)!.commandId, leaseEpoch: lose.leaseEpoch, result: 'rejected', detail: 'pid gone' },
    ] });
    expect(await job(keep.id)).toEqual(expect.objectContaining({ state: 'RUNNING', runnerBootId: 'boot-2' }));
    expect(await job(lose.id)).toEqual(expect.objectContaining({ state: 'CRASHED', leaseEpoch: lose.leaseEpoch + 1 }));
    await prisma.runner.update({ where: { id: runner.runnerId }, data: { capacity: 1, bootId: 'boot-1' } });
  });

  it('holds an idle sync and wakes it as soon as a command lands', async () => {
    const started = Date.now();
    const pending = sync({ bootId: 'boot-1' });
    await new Promise((r) => setTimeout(r, 150));
    const j = await dispatch('wake');
    const res = await pending;
    expect(res.commands.some((c) => c.jobId === j.id && c.type === 'ASSIGN')).toBe(true);
    expect(Date.now() - started).toBeLessThan(700);
  });
});
