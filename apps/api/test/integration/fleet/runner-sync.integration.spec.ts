/* eslint-disable @typescript-eslint/no-non-null-assertion -- the brief's test code asserts presence with toBeDefined and then uses ! */
/**
 * Fleet S1 slice 2 — POST /fleet/runner/sync: delivery, events, dedup, fence (PG).
 * Run: cd apps/api && bun run test:scoped test/integration/fleet/runner-sync.integration.spec.ts
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

describeIntegration('runner sync (PG)', () => {
  let app: NathApplication;
  let server: ReturnType<NathApplication['getHttpServer']>;
  let prisma: PrismaClient;
  let world: FleetHttpWorld;
  let runner: { runnerId: string; apiKey: string };
  const saved = process.env.FLEET_SYNC_WAIT_MS;

  const sync = async (over: Partial<SyncRequest> = {}, key = runner.apiKey) =>
    data<SyncResponse>(await request(server).post('/api/fleet/runner/sync').set({ Authorization: `Bearer ${key}` }).send(syncBody(over)).expect(200));
  const dispatch = async (feature: string) =>
    data<{ job: { id: string; state: string; leaseEpoch: number } }>(
      await request(server).post('/api/projects/web/fleet/jobs').set({ Authorization: `Bearer ${world.tokens.dev}` })
        .send({ repoId: world.repoId, command: 'RUN', maxCostUsd: 5, feature }).expect(201),
    ).job;
  const job = (id: string) => prisma.fleetJob.findUniqueOrThrow({ where: { id } });
  const ev = (seq: number, type: string, payload: object) => ({ seq, type: type as 'log', payload: payload as never });

  beforeAll(async () => {
    process.env.FLEET_SYNC_WAIT_MS = '0';
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

  it('answers 426 for another protocol version, 400 for garbage, 401 for a user token', async () => {
    const post = (body: unknown, token = runner.apiKey) => request(server).post('/api/fleet/runner/sync').set({ Authorization: `Bearer ${token}` }).send(body as object);
    await post({ ...syncBody(), protocolVersion: 99 }).expect(426);
    await post({ ...syncBody(), freeSlots: -1 }).expect(400);
    await post(syncBody(), world.tokens.root).expect(401);
  });

  it('re-sends an ASSIGN until it is acked, then applies events in order and dedups resends', async () => {
    const j = await dispatch('ev');
    expect(j.state).toBe('ASSIGNED');
    const first = await sync();
    const assign = first.commands.find((c) => c.jobId === j.id && c.type === 'ASSIGN');
    expect(assign).toBeDefined();
    expect((await sync()).commands.map((c) => c.commandId)).toContain(assign?.commandId);

    const events = [
      ev(1, 'state', { to: 'RUNNING' }),
      ev(2, 'snapshot', { naxRunId: 'run-1', costSpentUsd: '0.5', currentStoryId: 'US-001', progress: { done: 1 } }),
      ev(3, 'log', { stream: 'run', text: 'hello' }),
    ];
    const res = await sync({ commandAcks: [{ commandId: assign!.commandId, leaseEpoch: j.leaseEpoch, result: 'ok' }], jobs: [{ jobId: j.id, leaseEpoch: j.leaseEpoch, events }] });
    expect(res.jobAcks).toEqual([{ jobId: j.id, ackedSeq: 3 }]);
    expect(res.commands.map((c) => c.commandId)).not.toContain(assign!.commandId);
    expect(await job(j.id)).toEqual(expect.objectContaining({ state: 'RUNNING', naxRunId: 'run-1', currentStoryId: 'US-001' }));
    expect((await job(j.id)).costSpentUsd.toString()).toBe('0.5');

    const count = await prisma.fleetJobEvent.count({ where: { jobId: j.id } });
    expect((await sync({ jobs: [{ jobId: j.id, leaseEpoch: j.leaseEpoch, events }] })).jobAcks).toEqual([{ jobId: j.id, ackedSeq: 3 }]);
    expect(await prisma.fleetJobEvent.count({ where: { jobId: j.id } })).toBe(count);
  });

  it('stores events above a gap but acks and applies only the contiguous prefix', async () => {
    const running = await prisma.fleetJob.findFirstOrThrow({ where: { feature: 'ev' } });
    const e = { jobId: running.id, leaseEpoch: running.leaseEpoch };
    expect((await sync({ jobs: [{ ...e, events: [ev(5, 'state', { to: 'UPLOADING' })] }] })).jobAcks).toEqual([{ jobId: running.id, ackedSeq: 3 }]);
    expect((await job(running.id)).state).toBe('RUNNING');
    expect((await sync({ jobs: [{ ...e, events: [ev(4, 'log', { stream: 'run', text: 'gap' })] }] })).jobAcks).toEqual([{ jobId: running.id, ackedSeq: 5 }]);
    expect((await job(running.id)).state).toBe('UPLOADING');
  });

  it('rejects a resent seq with a different payload without advancing or storing', async () => {
    const running = await prisma.fleetJob.findFirstOrThrow({ where: { feature: 'ev' } });
    const before = await prisma.fleetJobEvent.count({ where: { jobId: running.id } });
    const res = await sync({ jobs: [{ jobId: running.id, leaseEpoch: running.leaseEpoch, events: [ev(3, 'log', { stream: 'run', text: 'changed' }), ev(6, 'log', { stream: 'run', text: 'new' })] }] });
    expect(res.jobAcks).toEqual([{ jobId: running.id, ackedSeq: 5 }]);
    expect(await prisma.fleetJobEvent.count({ where: { jobId: running.id } })).toBe(before);
  });

  it('stores but does not apply a transition outside the table, and records why', async () => {
    const j = await prisma.fleetJob.findFirstOrThrow({ where: { feature: 'ev' } });
    const res = await sync({ jobs: [{ jobId: j.id, leaseEpoch: j.leaseEpoch, events: [ev(6, 'state', { to: 'QUEUED' })] }] });
    expect(res.jobAcks).toEqual([{ jobId: j.id, ackedSeq: 6 }]);
    expect((await job(j.id)).state).toBe('UPLOADING');
    expect(await prisma.fleetActivity.count({ where: { jobId: j.id, action: 'job.event_rejected' } })).toBe(1);
  });

  it('fences a stale epoch: nothing stored, no ack, exactly one ABANDON across repeated syncs (review focus 1)', async () => {
    const j = await prisma.fleetJob.findFirstOrThrow({ where: { feature: 'ev' } });
    await prisma.fleetJob.update({ where: { id: j.id }, data: { leaseEpoch: j.leaseEpoch + 1 } }); // as if requeued elsewhere
    const before = await prisma.fleetJobEvent.count({ where: { jobId: j.id } });
    const stale = { jobs: [{ jobId: j.id, leaseEpoch: j.leaseEpoch, events: [ev(7, 'log', { stream: 'run', text: 'late' })] }] };
    const r1 = await sync(stale);
    const r2 = await sync(stale);
    expect(r1.jobAcks).toEqual([]);
    expect(r2.commands.filter((c) => c.type === 'ABANDON' && c.jobId === j.id)).toHaveLength(1);
    expect(await prisma.fleetCommand.count({ where: { jobId: j.id, type: 'ABANDON' } })).toBe(1);
    expect(await prisma.fleetJobEvent.count({ where: { jobId: j.id } })).toBe(before);
  });

  it('stores NUL-bearing strings with a replacement character instead of failing the sync (review M2)', async () => {
    const j = await prisma.fleetJob.findFirstOrThrow({ where: { feature: 'ev' } });
    await prisma.fleetJob.update({ where: { id: j.id }, data: { leaseEpoch: j.leaseEpoch - 1 } }); // undo the stale-epoch test's bump
    const held = await job(j.id);
    const res = await sync({ jobs: [{ jobId: j.id, leaseEpoch: held.leaseEpoch, events: [
      ev(7, 'log', { stream: 'run', text: 'nul\u0000here' }), ev(8, 'snapshot', { resultBranch: 'feat\u0000x' }),
    ] }] });
    expect(res.jobAcks).toEqual([{ jobId: j.id, ackedSeq: 8 }]);
    expect((await job(j.id)).resultBranch).toBe('feat\uFFFDx');
  });

  it('reports unknown job ids and stores new capabilities', async () => {
    const res = await sync({ jobs: [{ jobId: 'no-such-job', leaseEpoch: 1, events: [] }] });
    expect(res.unknownJobIds).toEqual(['no-such-job']);
    const caps = { ...(await prisma.runner.findUniqueOrThrow({ where: { id: runner.runnerId } })).capabilities as object, sandbox: { available: false, probedAt: '2026-10-02T00:00:00.000Z' } };
    await sync({ capabilities: caps as never });
    expect(((await prisma.runner.findUniqueOrThrow({ where: { id: runner.runnerId } })).capabilities as { sandbox: { available: boolean } }).sandbox.available).toBe(false);
  });

  it('fills free slots on sync, but never for a disabled runner', async () => {
    await prisma.runner.update({ where: { id: runner.runnerId }, data: { enabled: false } });
    const j = await dispatch('fill');
    expect(j.state).toBe('QUEUED');
    expect((await sync({ freeSlots: 1 })).commands.filter((c) => c.jobId === j.id)).toEqual([]);
    await prisma.runner.update({ where: { id: runner.runnerId }, data: { enabled: true } });
    await prisma.fleetJob.updateMany({ where: { runnerId: runner.runnerId, state: { in: ['ASSIGNED', 'RUNNING', 'UPLOADING'] } }, data: { state: 'FAILED' } });
    expect((await sync({ freeSlots: 1 })).commands.filter((c) => c.jobId === j.id && c.type === 'ASSIGN')).toHaveLength(1);
  });

  it('mirrors postRun from snapshots: present replaces, absent and all-invalid leave it (S2b (j) D428)', async () => {
    await prisma.fleetJob.updateMany({ where: { runnerId: runner.runnerId, state: { in: ['ASSIGNED', 'RUNNING', 'UPLOADING'] } }, data: { state: 'FAILED' } });
    const j = await dispatch('post-run');
    expect(j.state).toBe('ASSIGNED');
    const first = await sync();
    const assign = first.commands.find((c) => c.jobId === j.id && c.type === 'ASSIGN');
    expect(assign).toBeDefined();
    const e = { jobId: j.id, leaseEpoch: j.leaseEpoch };
    await sync({
      commandAcks: [{ commandId: assign!.commandId, leaseEpoch: j.leaseEpoch, result: 'ok' }],
      jobs: [{ ...e, events: [ev(1, 'state', { to: 'RUNNING' }), ev(2, 'snapshot', { postRun: { acceptance: 'running', regression: 'not-run' } })] }],
    });
    expect((await job(j.id)).postRun).toEqual({ acceptance: 'running', regression: 'not-run' });

    // absent: unchanged
    await sync({ jobs: [{ ...e, events: [ev(3, 'snapshot', { currentPhase: 'review' })] }] });
    expect(await job(j.id)).toEqual(expect.objectContaining({ currentPhase: 'review', postRun: { acceptance: 'running', regression: 'not-run' } }));

    // all-invalid: unchanged, the rest of the snapshot still applies
    const res = await sync({ jobs: [{ ...e, events: [ev(4, 'snapshot', { costSpentUsd: '0.25', postRun: { acceptance: 'x'.repeat(40) } })] }] });
    expect(res.jobAcks).toEqual([{ jobId: j.id, ackedSeq: 4 }]);
    const after = await job(j.id);
    expect(after.postRun).toEqual({ acceptance: 'running', regression: 'not-run' });
    expect(after.costSpentUsd.toString()).toBe('0.25');

    // present: replaces (no merge)
    await sync({ jobs: [{ ...e, events: [ev(5, 'snapshot', { postRun: { finish: 'passed' } })] }] });
    expect((await job(j.id)).postRun).toEqual({ finish: 'passed' });
  });
});
