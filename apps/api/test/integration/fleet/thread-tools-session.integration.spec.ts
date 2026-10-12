/**
 * Fleet S5a US-004 — tool summaries, questions, approvals and session state folded from the thread stream (PG).
 * Run: cd apps/api && bun run test:db:up && bun run test:scoped test/integration/fleet/thread-tools-session.integration.spec.ts
 */
import request from 'supertest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { NathApplication } from '@nathapp/nestjs-app';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { PrismaClient } from '../../../src/generated/prisma/client';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp, data } from '../../helpers/http-app';
import { enrollRunner, FleetHttpWorld, seedFleetHttpWorld, syncBody } from '../../helpers/fleet-fixtures';
import { putThreadLines, ThreadJobSeed } from '../../helpers/thread-fixtures';
import type { SyncRequest, SyncResponse } from '../../../src/fleet/common/protocol';

const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;
const ENV = ['FLEET_ARTIFACT_DIR', 'FLEET_THREADS_ENABLED', 'FLEET_SYNC_WAIT_MS'] as const;

describeIntegration('fleet thread tools, questions and session (PG, US-004)', () => {
  let app: NathApplication;
  let server: ReturnType<NathApplication['getHttpServer']>;
  let prisma: PrismaClient;
  let world: FleetHttpWorld;
  let runner: { runnerId: string; apiKey: string };
  const saved: Record<string, string | undefined> = {};

  beforeAll(async () => {
    for (const k of ENV) saved[k] = process.env[k];
    process.env.FLEET_THREADS_ENABLED = 'true';
    process.env.FLEET_SYNC_WAIT_MS = '800';
    process.env.FLEET_ARTIFACT_DIR = mkdtempSync(join(tmpdir(), 'koda-thread-tools-'));
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    server = app.getHttpServer();
    prisma = app.get<PrismaService<PrismaClient>>(PrismaService).client;
    world = await seedFleetHttpWorld(server, prisma);
    runner = await enrollRunner(server, world.tokens.root, 'tools-session-runner');
    await prisma.runner.update({ where: { id: runner.runnerId }, data: { protocolVersion: 4, lastSeenAt: new Date(), enabled: true, capacity: 1 } });
  });
  afterAll(async () => {
    await app.close();
    for (const k of ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  /** A fresh thread and RUNNING THREAD job held by the shared runner at lease epoch 1. */
  async function fresh(name: string, resume = false): Promise<ThreadJobSeed> {
    const thread = await prisma.chatThread.create({ data: {
      projectId: world.projectId, repoId: world.repoId, baseRef: 'trunk', feature: name, title: 'Tools fixture',
      createdById: world.ids.dev, runnerId: runner.runnerId, backend: { kind: 'native', model: 'm1' }, skills: [],
      specPath: `.nax/features/${name}/spec.md`,
    } });
    const job = await prisma.fleetJob.create({ data: {
      projectId: world.projectId, repoId: world.repoId, ref: 'trunk', command: 'THREAD', feature: `thread-${thread.id}`,
      profiles: [], selectorLabels: [], maxCostUsd: 5, requestedById: world.ids.dev, state: 'RUNNING',
      runnerId: runner.runnerId, leaseEpoch: 1, firstStartedAt: new Date(), threadId: thread.id,
    } });
    await prisma.fleetThreadTurn.create({ data: {
      jobId: job.id, threadId: thread.id, action: 'SESSION', instructions: 'go', backend: { kind: 'native', model: 'm1' }, skills: [], resume,
    } });
    return { threadId: thread.id, jobId: job.id, runnerId: runner.runnerId, runnerKey: runner.apiKey, feature: name };
  }
  const put = (s: ThreadJobSeed, lines: object[], offset = 0) =>
    putThreadLines(server, s.runnerKey, { id: s.jobId }, lines.map((l) => JSON.stringify(l)), offset);
  const asDev = () => ({ Authorization: `Bearer ${world.tokens.dev}` });
  const asRunnerSync = async (over: Partial<SyncRequest>) => data<SyncResponse>(
    await request(server).post('/api/fleet/runner/sync').set({ Authorization: `Bearer ${runner.apiKey}` }).send(syncBody(over)).expect(200),
  );
  const assistant = (s: ThreadJobSeed, turnId = 't1') =>
    prisma.chatMessage.findFirstOrThrow({ where: { threadId: s.threadId, turnId, role: 'assistant' } });
  const start = (turnId = 't1') => ({ type: 'turn_start', turnId });
  const end = (over: Record<string, unknown> = {}) => ({
    type: 'turn_end', turnId: 't1', status: 'completed', output: 'Final', usage: { inputTokens: 0, outputTokens: 0 }, costUsd: 0, ...over,
  });
  const E = '2026-10-14T01:00:00.000Z';

  it('US-004 AC1: a tool_call adds a toolSummary entry with the JSON input to the turn message', async () => {
    const s = await fresh('tools-ac1');
    await put(s, [start('t1'), { type: 'tool_call', turnId: 't1', callId: 'c1', name: 'search_repo', input: { pattern: 'foo' } }]);
    expect((await assistant(s)).toolSummary).toEqual([
      { callId: 'c1', name: 'search_repo', input: '{"pattern":"foo"}', isError: null, preview: '', decidedBy: null },
    ]);
  });

  it('US-004 AC2: a tool_result sets isError and preview on that entry in a later PUT', async () => {
    const s = await fresh('tools-ac2');
    const first = [start('t1'), { type: 'tool_call', turnId: 't1', callId: 'c1', name: 'search_repo', input: { pattern: 'foo' } }];
    const size = await put(s, first);
    await put(s, [{ type: 'tool_result', turnId: 't1', callId: 'c1', isError: true, preview: 'refused' }], size);
    expect((await assistant(s)).toolSummary).toEqual([
      expect.objectContaining({ callId: 'c1', isError: true, preview: 'refused' }),
    ]);
  });

  it('US-004 AC7: an answerable question sets the thread pendingQuestion', async () => {
    const s = await fresh('tools-ac7');
    await put(s, [start('t1'), { type: 'question', turnId: 't1', requestId: 'q1', text: 'Which repo?', expiresAt: E }]);
    const thread = await prisma.chatThread.findUniqueOrThrow({ where: { id: s.threadId } });
    expect(thread.pendingQuestion).toEqual({ requestId: 'q1', text: 'Which repo?', expiresAt: E });
  });

  it('US-004 AC9: a turn_end after an answerable question clears the thread pendingQuestion', async () => {
    const s = await fresh('tools-ac9');
    const size = await put(s, [start('t1'), { type: 'question', turnId: 't1', requestId: 'q1', text: 'Which repo?', expiresAt: E }]);
    await put(s, [end()], size);
    const thread = await prisma.chatThread.findUniqueOrThrow({ where: { id: s.threadId } });
    expect(thread.pendingQuestion).toBeNull();
  });

  it('US-004 AC10: an ok runner ack for the answered THREAD_ANSWER clears the pendingQuestion', async () => {
    const s = await fresh('tools-ac10');
    await put(s, [start('t1'), { type: 'question', turnId: 't1', requestId: 'q1', text: 'Which repo?', expiresAt: E }]);
    await request(server).post(`/api/projects/web/threads/${s.threadId}/answer`).set(asDev())
      .send({ requestId: 'q1', text: 'acme/app' }).expect(200);
    const command = await prisma.fleetCommand.findFirstOrThrow({ where: { jobId: s.jobId, type: 'THREAD_ANSWER' } });
    await asRunnerSync({ commandAcks: [{ commandId: command.id, leaseEpoch: 1, result: 'ok' }] });
    const thread = await prisma.chatThread.findUniqueOrThrow({ where: { id: s.threadId } });
    expect(thread.pendingQuestion).toBeNull();
  });

  it('US-004 AC11: a rejected runner ack for the THREAD_ANSWER keeps the pendingQuestion', async () => {
    const s = await fresh('tools-ac11');
    await put(s, [start('t1'), { type: 'question', turnId: 't1', requestId: 'q1', text: 'Which repo?', expiresAt: E }]);
    await request(server).post(`/api/projects/web/threads/${s.threadId}/answer`).set(asDev())
      .send({ requestId: 'q1', text: 'acme/app' }).expect(200);
    const command = await prisma.fleetCommand.findFirstOrThrow({ where: { jobId: s.jobId, type: 'THREAD_ANSWER' } });
    await asRunnerSync({ commandAcks: [{ commandId: command.id, leaseEpoch: 1, result: 'rejected', detail: 'not_pending' }] });
    const thread = await prisma.chatThread.findUniqueOrThrow({ where: { id: s.threadId } });
    expect(thread.pendingQuestion).toMatchObject({ requestId: 'q1' });
  });

  it('US-004 AC12: session_started folds a live session with contextReset false on a fresh turn', async () => {
    const s = await fresh('tools-ac12');
    await put(s, [{ type: 'session_started', at: '2026-10-14T00:00:00.000Z', resumed: false, backend: { kind: 'native' }, skillShas: [] }]);
    const thread = await prisma.chatThread.findUniqueOrThrow({ where: { id: s.threadId } });
    expect(thread.session).toEqual({ jobId: s.jobId, state: 'live', resumed: false, contextReset: false, reason: null, at: '2026-10-14T00:00:00.000Z' });
  });

  it('US-004 AC13: session_started with resumed false on a resume turn sets contextReset', async () => {
    const s = await fresh('tools-ac13', true);
    await put(s, [{ type: 'session_started', at: '2026-10-14T00:00:00.000Z', resumed: false, backend: { kind: 'native' }, skillShas: [] }]);
    const thread = await prisma.chatThread.findUniqueOrThrow({ where: { id: s.threadId } });
    expect(thread.session).toMatchObject({ resumed: false, contextReset: true });
  });

  it('US-004 AC14: session_failed errors the pending user message with the reason and keeps its content', async () => {
    const s = await fresh('tools-ac14');
    await prisma.chatMessage.create({ data: { threadId: s.threadId, seq: 1, role: 'user', authorUserId: world.ids.dev, content: 'hi', status: 'pending' } });
    await prisma.chatThread.update({ where: { id: s.threadId }, data: { nextSeq: 2 } });
    await put(s, [{ type: 'session_failed', reason: 'model_unknown' }]);
    const thread = await prisma.chatThread.findUniqueOrThrow({ where: { id: s.threadId } });
    expect(thread.session).toMatchObject({ state: 'failed', reason: 'model_unknown' });
    const message = await prisma.chatMessage.findFirstOrThrow({ where: { threadId: s.threadId, role: 'user' } });
    expect(message).toMatchObject({ status: 'errored', errorReason: 'model_unknown', content: 'hi' });
  });

  it('US-004 AC15: a project VIEWER reads session.state closed and its reason from GET thread', async () => {
    const s = await fresh('tools-ac15');
    const size = await put(s, [{ type: 'session_started', at: '2026-10-14T00:00:00.000Z', resumed: false, backend: { kind: 'native' }, skillShas: [] }]);
    await put(s, [{ type: 'session_closed', reason: 'idle' }], size);
    const res = await request(server).get(`/api/projects/web/threads/${s.threadId}`)
      .set('Authorization', `Bearer ${world.tokens.viewer}`).expect(200);
    const body = res.body.data as { session: { state: string; reason: string } };
    expect(body.session).toMatchObject({ state: 'closed', reason: 'idle' });
  });
});
