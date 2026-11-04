import { canRunDbTests } from '../../helpers/test-environment';
/**
 * thread-agents-modes US-008 — decide a session approval (PG).
 *
 * The decision routes are the text answer's twin: the same `THREAD_ANSWER` command and the same gates, but the
 * payload is `{ requestId, decision }` and `command()` checks it against `pendingApprovals` instead of
 * `pendingQuestion`. Every test here is about that split staying clean in both directions.
 *
 * Run: cd apps/api && bun run test:db:up && bun run test:scoped test/integration/fleet/thread-approval-decision.integration.spec.ts
 */
import request from 'supertest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { NathApplication } from '@nathapp/nestjs-app';
import { PrismaClient } from '../../../src/generated/prisma/client';
import { FLEET_CFG, type IFleetConfig } from '../../../src/config/fleet.config';
import { PermissionCache } from '../../../src/permissions/permission-cache';
import { grantRole } from '../../../src/permissions/test-helpers/permission-fixtures';
import { grantKeys } from '../../../src/approvals/test-helpers/approval-fixtures';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp, data, loginToken, resetThrottle, TEST_PASSWORD } from '../../helpers/http-app';
import { enrollRunner, FLEET_CAPS, FleetHttpWorld, seedFleetHttpAgent, seedFleetHttpWorld, syncBody } from '../../helpers/fleet-fixtures';
import { seedThreadJobFor, ThreadJobSeed } from '../../helpers/thread-fixtures';
import { fixtureDb } from '../../helpers/action-context';

// The nax sandbox withholds host Postgres/Docker.
const describeIntegration = canRunDbTests() ? describe : describe.skip;
const EXPIRES_AT = '2026-11-24T01:00:00.000Z';

/** The two locales' threads catalogs, so the 409 text is asserted against the files, not a literal. */
const EN = JSON.parse(readFileSync(join(__dirname, '../../../src/i18n/en/threads.json'), 'utf8')) as {
  noApproval: { '409': string }; noQuestion: { '409': string }; noSession: { '409': string }; sessionOtherPrincipal: { '409': string };
};
const ZH = JSON.parse(readFileSync(join(__dirname, '../../../src/i18n/zh/threads.json'), 'utf8')) as {
  noApproval?: { '409'?: string };
};

/** One pending entry as the ingest fold writes it. */
const approval = (requestId: string, summary = 'Run the test suite'): Record<string, unknown> => ({
  requestId, tool: 'bash', summary, command: 'bun run test', reason: 'reads the worktree', expiresAt: EXPIRES_AT, unsandboxed: true,
});

describeIntegration('fleet thread approval decisions (PG, US-008)', () => {
  let app: NathApplication;
  let server: ReturnType<NathApplication['getHttpServer']>;
  let prisma: PrismaClient;
  let world: FleetHttpWorld;
  let runner: { runnerId: string; apiKey: string };
  let agent: Awaited<ReturnType<typeof seedFleetHttpAgent>>;

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: true, ownerEmail: null });
    server = app.getHttpServer();
    prisma = fixtureDb(app);
    app.get<IFleetConfig>(FLEET_CFG).threadsEnabled = true;
    world = await seedFleetHttpWorld(server, prisma);
    runner = await enrollRunner(server, world.tokens.root, 'decision-runner');
    await prisma.runner.update({
      where: { id: runner.runnerId },
      data: { protocolVersion: 4, lastSeenAt: new Date(), enabled: true, capacity: 1 },
    });
    agent = await seedFleetHttpAgent(server, world.tokens.root);
    await grantKeys(prisma, { type: 'AGENT', id: agent.id }, ['project.read', 'thread.answer'], world.projectId);
    // AC-7: the viewer becomes a developer of the web project, so it holds `thread.answer.own` (a permission)
    // without being the thread's creator or the turn's requester.
    await grantRole(prisma, { type: 'USER', id: world.ids.viewer }, 'developer', world.projectId);
    await app.get(PermissionCache).invalidate();
  }, 90_000);
  afterAll(async () => {
    await app?.close();
  });
  beforeEach(() => resetThrottle(app));

  const projectPath = '/api/projects/web/threads';
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  /** A fresh thread created by dev, with a RUNNING THREAD job requested by dev at lease epoch 1. */
  const fresh = (name: string): Promise<ThreadJobSeed> => seedThreadJobFor(prisma, world, runner, { feature: name });
  /** Writes the fixture-pending list the ingest fold would have written. */
  const pending = (s: ThreadJobSeed, requestIds: string[]): Promise<unknown> =>
    prisma.chatThread.update({ where: { id: s.threadId }, data: { pendingApprovals: requestIds.map((id) => approval(id)) } });
  const decide = (s: ThreadJobSeed, requestId: string, body: unknown, token = world.tokens.dev) =>
    request(server).post(`${projectPath}/${s.threadId}/approvals/${requestId}`).set(auth(token)).send(body as object);
  const commandsOf = (s: ThreadJobSeed) => prisma.fleetCommand.findMany({ where: { jobId: s.jobId } });

  it('AC-1: an allow decision by the turn requester queues one THREAD_ANSWER decision command', async () => {
    const s = await fresh('decide-ac1');
    await pending(s, ['r1']);

    const res = await decide(s, 'r1', { decision: 'allow' }).expect(200);

    expect(data(res)).toEqual({});
    expect(await commandsOf(s)).toEqual([expect.objectContaining({
      type: 'THREAD_ANSWER', jobId: s.jobId, runnerId: s.runnerId, leaseEpoch: 1,
      payload: { requestId: 'r1', decision: 'allow' },
    })]);
  });

  it('AC-2: a deny decision queues the same command carrying deny', async () => {
    const s = await fresh('decide-ac2');
    await pending(s, ['r1']);

    await decide(s, 'r1', { decision: 'deny' }).expect(200);

    expect(await commandsOf(s)).toEqual([expect.objectContaining({
      type: 'THREAD_ANSWER', payload: { requestId: 'r1', decision: 'deny' },
    })]);
  });

  it('AC-3: the decision succeeds while a text question is pending and leaves pendingQuestion unchanged', async () => {
    const s = await fresh('decide-ac3');
    await pending(s, ['r1']);
    const question = { requestId: 'q9', text: 'Which database?' };
    await prisma.chatThread.update({ where: { id: s.threadId }, data: { pendingQuestion: question } });

    await decide(s, 'r1', { decision: 'allow' }).expect(200);

    const thread = await prisma.chatThread.findUniqueOrThrow({ where: { id: s.threadId } });
    expect(thread.pendingQuestion).toEqual(question);
    // The decision is not the cleanup: the ingest `approval_resolved` line owns removing the request (US-007).
    expect(thread.pendingApprovals).toEqual([expect.objectContaining({ requestId: 'r1' })]);
    expect(await commandsOf(s)).toEqual([expect.objectContaining({ payload: { requestId: 'r1', decision: 'allow' } })]);
  });

  it('AC-4: a request id that is not pending answers 409 threads.noApproval and queues nothing', async () => {
    const s = await fresh('decide-ac4');
    await pending(s, ['r1']);

    const res = await decide(s, 'r2', { decision: 'allow' }).expect(409);

    expect(res.body.message).toBe(EN.noApproval['409']);
    expect(await commandsOf(s)).toEqual([]);
  });

  it('AC-5: an unknown decision answers 400 naming decision and queues nothing', async () => {
    const s = await fresh('decide-ac5');
    await pending(s, ['r1']);

    const res = await decide(s, 'r1', { decision: 'maybe' }).expect(400);

    expect(res.body.message).toContain('decision');
    expect(await commandsOf(s)).toEqual([]);
  });

  it('AC-6: a pending request on a job that is no longer RUNNING answers 409 threads.noSession', async () => {
    const s = await fresh('decide-ac6');
    await pending(s, ['r1']);
    await prisma.fleetJob.update({ where: { id: s.jobId }, data: { state: 'COMPLETED', finishedAt: new Date() } });

    const res = await decide(s, 'r1', { decision: 'allow' }).expect(409);

    expect(res.body.message).toBe(EN.noSession['409']);
    expect(await commandsOf(s)).toEqual([]);
  });

  it('AC-7: a member who is not the turn requester answers 403 and queues nothing', async () => {
    const s = await fresh('decide-ac7');
    await pending(s, ['r1']);

    // The viewer holds `thread.answer.own` (developer), so the guard passes and the ownership compare refuses.
    const res = await decide(s, 'r1', { decision: 'allow' }, world.tokens.viewer).expect(403);

    expect(res.body.ret).not.toBe(0);
    expect(await commandsOf(s)).toEqual([]);
  });

  it('AC-8: the text answer for a request that is only pending approval still answers 409 threads.noQuestion', async () => {
    const s = await fresh('decide-ac8');
    await pending(s, ['r1']);

    const res = await request(server).post(`${projectPath}/${s.threadId}/answer`).set(auth(world.tokens.dev))
      .send({ requestId: 'r1', text: 'yes' }).expect(409);

    expect(res.body.message).toBe(EN.noQuestion['409']);
    expect(await commandsOf(s)).toEqual([]);
  });

  it('AC-9: a decision records an audit entry under thread.answer whose summary names the decision', async () => {
    const allowed = await fresh('decide-ac9-allow');
    await pending(allowed, ['r1']);
    await decide(allowed, 'r1', { decision: 'allow' }).expect(200);
    expect(await prisma.auditEntry.findFirst({ where: { resourceId: allowed.threadId, key: 'thread.answer' } }))
      .toMatchObject({ summary: expect.stringContaining('allow') });

    const denied = await fresh('decide-ac9-deny');
    await pending(denied, ['r2']);
    await decide(denied, 'r2', { decision: 'deny' }).expect(200);
    expect(await prisma.auditEntry.findFirst({ where: { resourceId: denied.threadId, key: 'thread.answer' } }))
      .toMatchObject({ summary: expect.stringContaining('deny') });
  });

  it('AC-10: the workspace route queues the decision command on the owner\'s live session', async () => {
    const thread = await prisma.chatThread.create({
      data: {
        kind: 'WORKSPACE', projectId: world.projectId, repoId: null, baseRef: null, feature: null, title: 'Workspace decision',
        createdById: agent.id, createdByType: 'AGENT', backend: { kind: 'native', model: 'm1' }, skills: [],
        pendingApprovals: [approval('w1')],
      },
    });
    const workspaceRunner = await prisma.runner.create({
      data: {
        name: 'workspace-decision-runner', apiKeyHash: 'workspace-decision-hash', os: 'linux', arch: 'x64', labels: [], capacity: 1,
        capabilities: { ...FLEET_CAPS, threadWrite: true }, daemonVersion: '0.1.0', protocolVersion: 4, bootId: 'workspace-decision-boot',
        enabled: true, lastSeenAt: new Date(), createdById: world.ids.root,
      },
    });
    const job = await prisma.fleetJob.create({
      data: {
        projectId: world.projectId, repoId: world.repoId, ref: 'main', command: 'THREAD', feature: `thread-${thread.id}`, profiles: [],
        maxCostUsd: 5, selectorLabels: [], requestedById: agent.id, requestedByType: 'AGENT', threadId: thread.id,
        runnerId: workspaceRunner.id, state: 'RUNNING', leaseEpoch: 3,
      },
    });
    await prisma.fleetThreadTurn.create({
      data: {
        jobId: job.id, threadId: thread.id, action: 'SESSION', initialMessageId: null, instructions: '',
        backend: { kind: 'native', model: 'm1' }, skills: [], resume: false,
      },
    });

    const res = await request(server).post(`/api/threads/${thread.id}/approvals/w1`).set(auth(agent.apiKey))
      .send({ decision: 'deny' }).expect(200);

    expect(data(res)).toEqual({});
    expect(await prisma.fleetCommand.findMany({ where: { jobId: job.id } })).toEqual([expect.objectContaining({
      type: 'THREAD_ANSWER', runnerId: workspaceRunner.id, leaseEpoch: 3, payload: { requestId: 'w1', decision: 'deny' },
    })]);
  });

  it('AC-11: the noApproval message is the English catalog text and the Chinese catalog has the key', async () => {
    const s = await fresh('decide-ac11');
    await pending(s, ['r1']);

    const res = await decide(s, 'unknown', { decision: 'allow' }).expect(409);

    expect(res.body.message).toBe(EN.noApproval['409']);
    expect(ZH.noApproval?.['409']).toBeTruthy();
  });

  /**
   * F2 (fix round 1): the pending lists are written by independent ingest paths, so a question and an approval can
   * carry the same request id. An accepted decision is not an answer to the question, and its ack must not delete it.
   */
  it('F2: the ack of a decision leaves a pendingQuestion that shares its request id', async () => {
    const s = await fresh('decide-ack-collision');
    await pending(s, ['r1']);
    const question = { requestId: 'r1', text: 'Which database?', expiresAt: EXPIRES_AT };
    await prisma.chatThread.update({ where: { id: s.threadId }, data: { pendingQuestion: question } });

    await decide(s, 'r1', { decision: 'allow' }).expect(200);
    const [command] = await commandsOf(s);
    if (!command) throw new Error('Missing decision command');
    // The runner accepts the decision, which is the ack that used to clear the question.
    await request(server).post('/api/fleet/runner/sync').set(auth(s.runnerKey))
      .send(syncBody({ protocolVersion: 4, commandAcks: [{ commandId: command.id, leaseEpoch: 1, result: 'ok' }] }))
      .expect(200);

    expect((await prisma.chatThread.findUniqueOrThrow({ where: { id: s.threadId } })).pendingQuestion).toEqual(question);
  });

  it('the ack of a text answer still clears its question', async () => {
    const s = await fresh('answer-ack-clears');
    const question = { requestId: 'q1', text: 'Which database?', expiresAt: EXPIRES_AT };
    await prisma.chatThread.update({ where: { id: s.threadId }, data: { pendingQuestion: question } });

    await request(server).post(`${projectPath}/${s.threadId}/answer`).set(auth(world.tokens.dev))
      .send({ requestId: 'q1', text: 'postgres' }).expect(200);
    const [command] = await commandsOf(s);
    if (!command) throw new Error('Missing answer command');
    await request(server).post('/api/fleet/runner/sync').set(auth(s.runnerKey))
      .send(syncBody({ protocolVersion: 4, commandAcks: [{ commandId: command.id, leaseEpoch: 1, result: 'ok' }] }))
      .expect(200);

    expect((await prisma.chatThread.findUniqueOrThrow({ where: { id: s.threadId } })).pendingQuestion).toBeNull();
  });

  it('the thread creator who is not the turn requester is refused the session, not the row', async () => {
    const s = await fresh('decide-other-requester');
    await pending(s, ['r1']);
    // The live turn belongs to someone else, so the creator's decision would steer another principal's session.
    await prisma.fleetJob.update({ where: { id: s.jobId }, data: { requestedById: world.ids.viewer, requestedByType: 'USER' } });

    const res = await decide(s, 'r1', { decision: 'allow' }).expect(409);

    expect(res.body.message).toBe(EN.sessionOtherPrincipal['409']);
    expect(await commandsOf(s)).toEqual([]);
  });

  it('an any-row thread.answer holder who is not the requester is refused the session', async () => {
    const s = await fresh('decide-any-row');
    await pending(s, ['r1']);
    await request(server).post('/api/admin/users').set(auth(world.tokens.root))
      .send({ email: 'anyrow@koda.test', name: 'Anyrow', password: TEST_PASSWORD, role: 'MEMBER' }).expect(201);
    const anyRow = await prisma.user.findUniqueOrThrow({ where: { email: 'anyrow@koda.test' } });
    await grantRole(prisma, { type: 'USER', id: anyRow.id }, 'project-admin', world.projectId);
    await app.get(PermissionCache).invalidate();
    const token = await loginToken(server, 'anyrow@koda.test');

    const res = await decide(s, 'r1', { decision: 'allow' }, token).expect(409);

    expect(res.body.message).toBe(EN.sessionOtherPrincipal['409']);
    expect(await commandsOf(s)).toEqual([]);
  });

  it('the workspace decision route answers 404 for a thread the caller does not own', async () => {
    const s = await fresh('decide-workspace-foreign');
    await pending(s, ['r1']);

    const res = await request(server).post(`/api/threads/${s.threadId}/approvals/r1`).set(auth(agent.apiKey))
      .send({ decision: 'allow' }).expect(404);

    expect(res.body.message).toBe('Thread not found');
    expect(await commandsOf(s)).toEqual([]);
  });
});
