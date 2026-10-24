import { canRunDbTests } from '../../helpers/test-environment';
/**
 * Fleet S5a US-003 — the assistant message lifecycle folded from the thread stream (PG).
 * Run: cd apps/api && bun run test:db:up && bun run test:scoped test/integration/fleet/thread-assistant-lifecycle.integration.spec.ts
 */
import request from 'supertest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { NathApplication } from '@nathapp/nestjs-app';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { TRANSACTION_MANAGER } from '@nathapp/nestjs-data';
import { PrismaClient } from '../../../src/generated/prisma/client';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp } from '../../helpers/http-app';
import { enrollRunner, FleetHttpWorld, seedFleetHttpWorld } from '../../helpers/fleet-fixtures';
import { putThreadLines, seedThreadJobFor, ThreadJobSeed } from '../../helpers/thread-fixtures';
import { LogStore, LOG_STORE, logKey } from '../../../src/fleet/logs/log-store';
import { ThreadIngestor } from '../../../src/fleet/threads/ingest/thread-ingestor';
import { JobTransitionsService } from '../../../src/fleet/jobs/job-transitions.service';
import { SYSTEM_ACTOR } from '../../../src/fleet/common/system-actor';
import { FLEET_JOB_REPOSITORY, type FleetJobRecord, type IFleetJobRepository } from '../../../src/fleet/jobs/domain/fleet-job.domain';

// The nax sandbox withholds host Postgres/Docker.
const describeIntegration = canRunDbTests() ? describe : describe.skip;
const ENV = ['FLEET_ARTIFACT_DIR', 'FLEET_THREADS_ENABLED'] as const;

describeIntegration('fleet thread assistant lifecycle (PG, US-003)', () => {
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
    artifactDir = mkdtempSync(join(tmpdir(), 'koda-thread-lifecycle-'));
    process.env.FLEET_ARTIFACT_DIR = artifactDir;
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    server = app.getHttpServer();
    prisma = app.get<PrismaService<PrismaClient>>(PrismaService).client;
    world = await seedFleetHttpWorld(server, prisma);
    // POST /fleet/runner/enroll is throttled to 10 per minute per route, so one runner serves every case.
    runner = await enrollRunner(server, world.tokens.root, 'lifecycle-runner');
    // A send refuses an offline runner or one below protocol v4, so the shared runner is online and current.
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
  const fresh = (name: string): Promise<ThreadJobSeed> =>
    seedThreadJobFor(prisma, world, runner, { feature: name });
  const put = (s: ThreadJobSeed, lines: object[], offset = 0) =>
    putThreadLines(server, s.runnerKey, { id: s.jobId }, lines.map((l) => JSON.stringify(l)), offset);
  const assistant = (s: ThreadJobSeed, turnId = 't1') =>
    prisma.chatMessage.findFirstOrThrow({ where: { threadId: s.threadId, turnId, role: 'assistant' } });
  const start = (turnId = 't1') => ({ type: 'turn_start', turnId });
  const delta = (text: string, round = 1, turnId = 't1') => ({ type: 'text_delta', turnId, round, text });
  const reset = (round: number, turnId = 't1') => ({ type: 'stream_reset', turnId, round });
  const end = (over: Record<string, unknown> = {}) => ({
    type: 'turn_end', turnId: 't1', status: 'completed', output: 'Final', usage: { inputTokens: 0, outputTokens: 0 }, costUsd: 0, ...over,
  });
  const cursor = (s: ThreadJobSeed) => prisma.threadIngestCursor.findUniqueOrThrow({ where: { jobId_leaseEpoch: { jobId: s.jobId, leaseEpoch: 1 } } });

  it('US-003 AC1: turn_start creates one streaming assistant message at seq 2 with jobId and turnId', async () => {
    const s = await fresh('lifecycle-ac1');
    await prisma.chatMessage.create({ data: { threadId: s.threadId, seq: 1, role: 'user', authorUserId: world.ids.dev, content: 'hi', status: 'complete' } });
    await prisma.chatThread.update({ where: { id: s.threadId }, data: { nextSeq: 2 } });
    await put(s, [start('t1')]);
    expect(await assistant(s)).toMatchObject({ role: 'assistant', status: 'streaming', content: '', seq: 2, jobId: s.jobId, turnId: 't1' });
  });

  it('US-003 AC2: text_delta lines in two PUTs concatenate into one content', async () => {
    const s = await fresh('lifecycle-ac2');
    await put(s, [start('t1'), delta('Hel')]);
    await put(s, [delta('lo')], Buffer.byteLength(`${JSON.stringify(start('t1'))}\n${JSON.stringify(delta('Hel'))}\n`));
    expect((await assistant(s)).content).toBe('Hello');
  });

  it('US-003 AC3: stream_reset of the same round replaces its provisional text', async () => {
    const s = await fresh('lifecycle-ac3');
    await put(s, [start('t1'), delta('abc'), reset(1), delta('xyz')]);
    expect((await assistant(s)).content).toBe('xyz');
  });

  it('US-003 AC4: resetting round two keeps the text of round one', async () => {
    const s = await fresh('lifecycle-ac4');
    await put(s, [start('t1'), delta('one '), delta('two', 2), reset(2), delta('TWO', 2)]);
    expect((await assistant(s)).content).toBe('one TWO');
  });

  it('US-003 AC5: a completed turn_end sets the final output and status complete', async () => {
    const s = await fresh('lifecycle-ac5');
    await put(s, [start('t1'), delta('partial'), end({ status: 'completed', output: 'Final' })]);
    expect(await assistant(s)).toMatchObject({ content: 'Final', status: 'complete' });
  });

  it('US-003 AC6: a cancelled turn_end keeps the streamed content and sets status cancelled', async () => {
    const s = await fresh('lifecycle-ac6');
    await put(s, [start('t1'), delta('partial'), end({ status: 'cancelled', output: '' })]);
    expect(await assistant(s)).toMatchObject({ content: 'partial', status: 'cancelled' });
  });

  it('US-003 AC7: an errored turn_end sets errorReason to the error message', async () => {
    const s = await fresh('lifecycle-ac7');
    await put(s, [start('t1'), end({ status: 'errored', output: '', error: { code: 'E', message: 'boom' } })]);
    expect(await assistant(s)).toMatchObject({ status: 'errored', errorReason: 'boom' });
  });

  it('US-003 AC8: catchUp over an already folded stream leaves content and message count unchanged', async () => {
    const s = await fresh('lifecycle-ac8');
    await put(s, [start('t1'), delta('Hello')]);
    const before = await prisma.chatMessage.count({ where: { threadId: s.threadId } });
    await app.get(ThreadIngestor).catchUp(s.jobId, 1);
    expect((await assistant(s)).content).toBe('Hello');
    expect(await prisma.chatMessage.count({ where: { threadId: s.threadId } })).toBe(before);
  });

  it('US-003 AC9: a late turn_end appended after a crash keeps the message errored and sets its content', async () => {
    const s = await fresh('lifecycle-ac9');
    await put(s, [start('t1'), delta('partial')]);
    const transitions = app.get(JobTransitionsService);
    const jobs = app.get<IFleetJobRepository>(FLEET_JOB_REPOSITORY);
    await app.get(TRANSACTION_MANAGER).run(async () => transitions.apply({
      job: (await jobs.findById(s.jobId)) as FleetJobRecord,
      to: 'CRASHED', by: 'server', now: new Date(), actor: SYSTEM_ACTOR, reason: 'test crash',
    }));
    expect((await assistant(s)).status).toBe('errored');
    const late = Buffer.from(`${JSON.stringify(end({ output: 'Late' }))}\n`);
    const store = app.get<LogStore>(LOG_STORE);
    const key = logKey(s.jobId, 1, 'thread');
    await store.withLock(key, async () => store.append(key, await store.size(key), late));
    await prisma.fleetJobLog.update({
      where: { jobId_leaseEpoch_stream: { jobId: s.jobId, leaseEpoch: 1, stream: 'thread' } },
      data: { sizeBytes: BigInt(await store.size(key)) },
    });
    await app.get(ThreadIngestor).catchUp(s.jobId, 1);
    expect(await assistant(s)).toMatchObject({ status: 'errored', content: 'Late' });
  });

  it('US-003 AC10: text_delta for a turn with no turn_start creates no message and skips one line', async () => {
    const s = await fresh('lifecycle-ac10');
    await put(s, [delta('x', 0, 't9')]);
    expect(await prisma.chatMessage.count({ where: { threadId: s.threadId, turnId: 't9' } })).toBe(0);
    expect((await cursor(s)).skippedLines).toBe(1);
  });

  it('US-003 AC11: a second turn_start for the same turnId keeps one assistant and skips one line', async () => {
    const s = await fresh('lifecycle-ac11');
    await put(s, [start('t1'), start('t1')]);
    expect(await prisma.chatMessage.count({ where: { threadId: s.threadId, turnId: 't1', role: 'assistant' } })).toBe(1);
    expect((await cursor(s)).skippedLines).toBe(1);
  });

  it('US-003 AC12: an escaped NUL in text_delta is stored as U+FFFD', async () => {
    const s = await fresh('lifecycle-ac12');
    await put(s, [start('t1'), { type: 'text_delta', turnId: 't1', round: 1, text: 'a\u0000b' }]);
    expect((await assistant(s)).content).toBe('a\uFFFDb');
  });

  it('US-003 AC13: GET messages answers without streamRound or streamRoundStart keys', async () => {
    const s = await fresh('lifecycle-ac13');
    await put(s, [start('t1'), delta('Hi')]);
    const res = await request(server).get(`/api/projects/web/threads/${s.threadId}/messages`)
      .set('Authorization', `Bearer ${world.tokens.dev}`).expect(200);
    const items = res.body.data.items as Array<Record<string, unknown>>;
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) {
      expect(Object.hasOwn(item, 'streamRound')).toBe(false);
      expect(Object.hasOwn(item, 'streamRoundStart')).toBe(false);
    }
  });

  it('US-003 AC14: POST messages answers with a message without streamRound or streamRoundStart keys', async () => {
    // A thread with no live job: the send is accepted and creates the message without a turn in flight.
    const thread = await prisma.chatThread.create({ data: {
      projectId: world.projectId, repoId: world.repoId, baseRef: 'trunk', feature: 'lifecycle-ac14', title: 'Lifecycle send',
      createdById: world.ids.dev, runnerId: runner.runnerId, backend: { kind: 'native', model: 'm1' }, skills: [],
      specPath: '.nax/features/lifecycle-ac14/spec.md',
    } });
    const res = await request(server).post(`/api/projects/web/threads/${thread.id}/messages`)
      .set('Authorization', `Bearer ${world.tokens.dev}`).send({ text: 'hello', clientMessageId: 'ac14-message' }).expect(201);
    const message = (res.body.data as { message: Record<string, unknown> }).message;
    expect(Object.hasOwn(message, 'streamRound')).toBe(false);
    expect(Object.hasOwn(message, 'streamRoundStart')).toBe(false);
  });
});
