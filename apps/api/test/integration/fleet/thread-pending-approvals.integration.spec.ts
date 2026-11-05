import { canRunDbTests } from '../../helpers/test-environment';
/**
 * thread-agents-modes US-007 — session approvals become a bounded pending list on the thread (PG).
 * Run: cd apps/api && bun run test:db:up && bun run test:scoped test/integration/fleet/thread-pending-approvals.integration.spec.ts
 */
import request from 'supertest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { NathApplication } from '@nathapp/nestjs-app';
import { PrismaClient } from '../../../src/generated/prisma/client';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp, data } from '../../helpers/http-app';
import { enrollRunner, FleetHttpWorld, seedFleetHttpWorld } from '../../helpers/fleet-fixtures';
import { putThreadLines, seedThreadJobFor, ThreadJobSeed } from '../../helpers/thread-fixtures';
import { ThreadJobEffects } from '../../../src/fleet/threads/thread-job-effects';
import { PrismaThreadIngestRepository } from '../../../src/fleet/threads/ingest/prisma-thread-ingest.repository';
import type { ThreadLine } from '../../../src/fleet/threads/ingest/thread-line';
import type { FleetJobRecord } from '../../../src/fleet/jobs/domain/fleet-job.domain';
import { expectGuardActive, fixtureDb, withTestActor } from '../../helpers/action-context';

// The nax sandbox withholds host Postgres/Docker.
const describeIntegration = canRunDbTests() ? describe : describe.skip;
const ENV = ['FLEET_ARTIFACT_DIR', 'FLEET_THREADS_ENABLED'] as const;
const EXPIRES_AT = '2026-11-24T01:00:00.000Z';

/** One pending entry as the thread DTO answers it. */
interface PendingApproval {
  requestId: string; tool: string; summary: string; command?: string; reason?: string; expiresAt: string; unsandboxed?: true;
}

describeIntegration('fleet thread pending approvals (PG, US-007)', () => {
  let app: NathApplication;
  let artifactDir: string | undefined;
  let server: ReturnType<NathApplication['getHttpServer']>;
  let prisma: PrismaClient;
  let world: FleetHttpWorld;
  let runner: { runnerId: string; apiKey: string };
  const saved: Record<string, string | undefined> = {};

  beforeAll(async () => {
    for (const k of ENV) saved[k] = process.env[k];
    process.env.FLEET_THREADS_ENABLED = 'true';
    artifactDir = mkdtempSync(join(tmpdir(), 'koda-thread-approvals-'));
    process.env.FLEET_ARTIFACT_DIR = artifactDir;
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    server = app.getHttpServer();
    prisma = fixtureDb(app);
    world = await seedFleetHttpWorld(server, prisma);
    runner = await enrollRunner(server, world.tokens.root, 'pending-approvals-runner');
    await prisma.runner.update({ where: { id: runner.runnerId }, data: { protocolVersion: 4, lastSeenAt: new Date(), enabled: true, capacity: 1 } });
  });
  afterAll(async () => {
    try {
      await app?.close();
    } finally {
      for (const k of ENV) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
      if (artifactDir) rmSync(artifactDir, { recursive: true, force: true });
    }
  });

  /** A fresh thread and RUNNING THREAD job held by the shared runner at lease epoch 1. */
  const fresh = (name: string): Promise<ThreadJobSeed> => seedThreadJobFor(prisma, world, runner, { feature: name });
  const put = (s: ThreadJobSeed, lines: object[], offset = 0) =>
    putThreadLines(server, s.runnerKey, { id: s.jobId }, lines.map((line) => JSON.stringify(line)), offset);
  const pendingOf = async (s: ThreadJobSeed): Promise<unknown> =>
    (await prisma.chatThread.findUniqueOrThrow({ where: { id: s.threadId }, select: { pendingApprovals: true } })).pendingApprovals;
  const approval = (over: Record<string, unknown> = {}): object => ({
    type: 'approval_requested', requestId: 'r1', tool: 'bash', summary: 'Run the test suite',
    command: 'bun run test', reason: 'reads the worktree', expiresAt: EXPIRES_AT, unsandboxed: true, ...over,
  });

  it('writes need an action context', async () => {
    await expect(expectGuardActive(app)).resolves.toBeUndefined();
  });

  it('US-007 AC-5: appends an answerable request with no callId to pendingApprovals', async () => {
    const s = await fresh('approvals-ac5');
    await put(s, [approval()]);
    expect(await pendingOf(s)).toEqual([{
      requestId: 'r1', tool: 'bash', summary: 'Run the test suite', command: 'bun run test',
      reason: 'reads the worktree', expiresAt: EXPIRES_AT, unsandboxed: true,
    }]);
  });

  it('US-007 AC-6: an answerable false request leaves pendingApprovals unchanged', async () => {
    const s = await fresh('approvals-ac6');
    const size = await put(s, [approval({ requestId: 'r1' })]);
    await put(s, [approval({ requestId: 'r2', answerable: false })], size);
    expect(await pendingOf(s)).toEqual([expect.objectContaining({ requestId: 'r1' })]);
  });

  it('US-007 AC-7: a request without a summary leaves pendingApprovals unchanged', async () => {
    const s = await fresh('approvals-ac7');
    await put(s, [{ ...(approval({ requestId: 'r1' }) as Record<string, unknown>), summary: undefined }]);
    expect(await pendingOf(s)).toBeNull();
  });

  it('US-007 AC-8: the matching approval_resolved removes that request', async () => {
    const s = await fresh('approvals-ac8');
    const size = await put(s, [approval({ requestId: 'r1' }), approval({ requestId: 'r2' })]);
    await put(s, [{ type: 'approval_resolved', requestId: 'r1', decision: 'allow', decidedBy: 'user' }], size);
    expect(await pendingOf(s)).toEqual([expect.objectContaining({ requestId: 'r2' })]);
  });

  it('US-007 AC-9: a session_closed line clears pendingApprovals', async () => {
    const s = await fresh('approvals-ac9');
    const size = await put(s, [approval()]);
    await put(s, [{ type: 'session_closed', reason: 'idle' }], size);
    expect(await pendingOf(s)).toBeNull();
  });

  it('US-007 AC-10: the job ending as CRASHED clears pendingApprovals through onJobEnded', async () => {
    const s = await seedThreadJobFor(prisma, world, runner, { feature: 'approvals-ac10' });
    await prisma.chatThread.update({ where: { id: s.threadId }, data: { pendingApprovals: [{
      requestId: 'r1', tool: 'bash', summary: 'Run the test suite', expiresAt: EXPIRES_AT,
    }] } });
    await prisma.fleetJob.update({ where: { id: s.jobId }, data: { state: 'CRASHED', finishedAt: new Date() } });
    const job = await prisma.fleetJob.findUniqueOrThrow({ where: { id: s.jobId } });
    // The runner hosts the job that ended, so the effect runs as that runner.
    await withTestActor({ type: 'RUNNER', id: runner.runnerId }, () =>
      app.get(ThreadJobEffects, { strict: false }).onJobEnded(job as unknown as FleetJobRecord));
    expect(await pendingOf(s)).toBeNull();
  });

  it('US-007 AC-11: a 21st pending request leaves the oldest twenty', async () => {
    const s = await fresh('approvals-ac11');
    await put(s, Array.from({ length: 21 }, (_, i) => approval({ requestId: `r${i + 1}` })));
    const pending = await pendingOf(s) as PendingApproval[];
    expect(pending.map((row) => row.requestId)).toEqual(Array.from({ length: 20 }, (_, i) => `r${i + 1}`));
  });

  it('US-007 AC-12: GET the thread answers pendingApprovals oldest first and its mode', async () => {
    const s = await fresh('approvals-ac12');
    await prisma.chatThread.update({ where: { id: s.threadId }, data: { mode: 'ask' } });
    await put(s, [approval({ requestId: 'r1', summary: 'First' }), approval({ requestId: 'r2', summary: 'Second' })]);
    const res = await request(server).get(`/api/projects/web/threads/${s.threadId}`)
      .set('Authorization', `Bearer ${world.tokens.dev}`).expect(200);
    const thread = data<{ mode: string; pendingApprovals: PendingApproval[] }>(res);
    expect(thread.mode).toBe('ask');
    expect(thread.pendingApprovals.map((row) => row.requestId)).toEqual(['r1', 'r2']);
    expect(thread.pendingApprovals[0]).toEqual({
      requestId: 'r1', tool: 'bash', summary: 'First', command: 'bun run test',
      reason: 'reads the worktree', expiresAt: EXPIRES_AT, unsandboxed: true,
    });
  });

  it('US-007 AC-12: GET a thread with no pending approvals answers an empty list', async () => {
    const s = await fresh('approvals-ac12-empty');
    const res = await request(server).get(`/api/projects/web/threads/${s.threadId}`)
      .set('Authorization', `Bearer ${world.tokens.dev}`).expect(200);
    expect(data<{ pendingApprovals: unknown }>(res).pendingApprovals).toEqual([]);
  });

  /** Folds parsed lines the way `ThreadIngestBootstrap` catch-up does: as the `thread` system component. */
  const foldLines = (job: { id: string }, lines: ThreadLine[], endOffset = 1024, leaseEpoch = 1): Promise<unknown> =>
    withTestActor({ type: 'SYSTEM', id: 'thread' }, () =>
      app.get(PrismaThreadIngestRepository, { strict: false }).fold({
        jobId: job.id, leaseEpoch, badLines: 0, endOffset,
        lines: lines.map((line, i) => ({ line, endOffset: (i + 1) * 10 })),
      }));
  const listApproval = (requestId: string, summary = 'Run the test suite'): ThreadLine => ({
    type: 'approval_requested', requestId, tool: 'bash', summary, command: 'bun run test', reason: 'reads the worktree',
    expiresAt: EXPIRES_AT, unsandboxed: true, answerable: true,
  });

  it('US-007 F1: catch-up after the crash leaves the cleared list cleared and still folds the transcript', async () => {
    const s = await seedThreadJobFor(prisma, world, runner, { feature: 'approvals-f1-crash' });
    await foldLines({ id: s.jobId }, [listApproval('r1')]);
    expect(await pendingOf(s)).toEqual([expect.objectContaining({ requestId: 'r1' })]);
    await prisma.fleetJob.update({ where: { id: s.jobId }, data: { state: 'CRASHED', finishedAt: new Date() } });
    const job = await prisma.fleetJob.findUniqueOrThrow({ where: { id: s.jobId } });
    await withTestActor({ type: 'RUNNER', id: runner.runnerId }, () =>
      app.get(ThreadJobEffects, { strict: false }).onJobEnded(job as unknown as FleetJobRecord));
    expect(await pendingOf(s)).toBeNull();
    // A crashed stream need not carry a closing event: the boot catch-up replays the request the cleanup dropped.
    await foldLines({ id: s.jobId }, [listApproval('r1'), { type: 'turn_start', turnId: 't9' }], 2048);
    expect(await pendingOf(s)).toBeNull();
    expect(await prisma.chatMessage.count({ where: { threadId: s.threadId, turnId: 't9' } })).toBe(1);
  });

  it('US-007 F1: a replayed terminated attempt leaves the live session request listed', async () => {
    const s = await fresh('approvals-f1-live');
    await foldLines({ id: s.jobId }, [listApproval('r-live', 'Live')]);
    // The attempt that held the job is over; the thread's list belongs to the session that is live now.
    const dead = await prisma.fleetJob.create({ data: {
      projectId: world.projectId, repoId: world.repoId, ref: 'trunk', command: 'THREAD', feature: `thread-${s.threadId}`,
      profiles: [], selectorLabels: [], maxCostUsd: '5', requestedById: world.ids.dev, state: 'CRASHED',
      runnerId: runner.runnerId, leaseEpoch: 1, threadId: s.threadId,
    } });
    await foldLines({ id: dead.id }, [listApproval('r-dead', 'Dead'), { type: 'approval_resolved', requestId: 'r-live', decidedBy: 'user' }], 512);
    expect(await pendingOf(s)).toEqual([expect.objectContaining({ requestId: 'r-live' })]);
  });

  it('US-007 F1: a replay under a replaced lease epoch leaves the current attempt list alone', async () => {
    const s = await fresh('approvals-f1-epoch');
    await prisma.fleetJob.update({ where: { id: s.jobId }, data: { leaseEpoch: 2 } });
    await foldLines({ id: s.jobId }, [listApproval('r-old')], 512, 1);
    expect(await pendingOf(s)).toBeNull();
  });
});
