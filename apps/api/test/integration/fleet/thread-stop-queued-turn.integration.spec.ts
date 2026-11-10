import request from 'supertest';
import type { NathApplication } from '@nathapp/nestjs-app';
import { grantKeys, seedWaitPolicy } from '../../../src/approvals/test-helpers/approval-fixtures';
import { FLEET_CFG, type IFleetConfig } from '../../../src/config/fleet.config';
import { PermissionCache } from '../../../src/permissions/permission-cache';
import { fixtureDb } from '../../helpers/action-context';
import { bootHttpApp, data, resetThrottle } from '../../helpers/http-app';
import { FLEET_CAPS, seedFleetHttpAgent, seedFleetHttpWorld, type FleetHttpWorld } from '../../helpers/fleet-fixtures';
import { resetDb } from '../../helpers/reset-db';
import { canRunDbTests } from '../../helpers/test-environment';

const describeIntegration = canRunDbTests() ? describe : describe.skip;

type TurnState = 'QUEUED' | 'ASSIGNED' | 'RUNNING';
type TurnAction = 'SESSION' | 'PUBLISH' | 'DISCARD';

/**
 * #428: a SESSION turn no runner has started (QUEUED, or ASSIGNED with the ASSIGN never acked) has no runner to send
 * THREAD_STOP_TURN to. Stop cancels the job server-side, the turn's pending message ends errored, the thread audit
 * records the stop, and no stop command is written. A RUNNING turn still gets the stop command, and a queued PUBLISH
 * or DISCARD job is never Stop's to cancel.
 */
describeIntegration('thread Stop on a turn no runner has started (#428)', () => {
  let app: NathApplication;
  let db: ReturnType<typeof fixtureDb>;
  let world: FleetHttpWorld;
  let agent: Awaited<ReturnType<typeof seedFleetHttpAgent>>;
  let n = 0;
  const server = () => app.getHttpServer();
  const auth = (token = world.tokens.root) => ({ Authorization: `Bearer ${token}` });

  const thread = (kind: 'REPO' | 'WORKSPACE', createdById = world.ids.root) => {
    n += 1;
    return db.chatThread.create({ data: {
      kind, projectId: world.projectId, repoId: kind === 'REPO' ? world.repoId : null, baseRef: kind === 'REPO' ? 'main' : null,
      feature: kind === 'REPO' ? `stop-${n}` : null, title: `Stop ${n}`, createdById, createdByType: createdById === world.ids.root ? 'USER' : 'AGENT',
      backend: { kind: 'native', model: 'm1' }, skills: [],
    } });
  };

  const turn = async (threadId: string, state: TurnState, opts: { action?: TurnAction; acked?: boolean } = {}) => {
    n += 1;
    const runner = state === 'QUEUED' ? null : await db.runner.create({ data: {
      name: `stop-runner-${n}`, apiKeyHash: `stop-hash-${n}`, os: 'linux', arch: 'x64', labels: [], capacity: 2,
      capabilities: { ...FLEET_CAPS, threadWrite: true }, daemonVersion: '0.1.0', protocolVersion: 4, bootId: `stop-boot-${n}`,
      enabled: true, lastSeenAt: new Date(), createdById: world.ids.root,
    } });
    const job = await db.fleetJob.create({ data: {
      projectId: world.projectId, repoId: world.repoId, ref: 'main', command: 'THREAD', feature: `thread-${threadId}`, profiles: [],
      maxCostUsd: 5, selectorLabels: [], requestedById: world.ids.root, requestedByType: 'USER', threadId,
      runnerId: runner?.id ?? null, state, leaseEpoch: runner ? 2 : 0,
    } });
    if (state === 'ASSIGNED' && runner) {
      await db.fleetCommand.create({ data: {
        runnerId: runner.id, jobId: job.id, type: 'ASSIGN', leaseEpoch: 2, payload: {},
        ...(opts.acked ? { deliveredAt: new Date(), ackedAt: new Date(), ackResult: 'ok' } : {}),
      } });
    }
    await db.fleetThreadTurn.create({ data: {
      jobId: job.id, threadId, action: opts.action ?? 'SESSION', initialMessageId: null, instructions: '',
      backend: { kind: 'native', model: 'm1' }, skills: [], resume: false,
    } });
    const message = await db.chatMessage.create({ data: {
      threadId, seq: 1, role: 'user', status: 'pending', content: 'hello', jobId: job.id, turnId: job.id,
      authorUserId: world.ids.root, authorType: 'USER', clientMessageId: `c-${n}`,
    } });
    return { job, message };
  };

  const jobState = async (id: string) => (await db.fleetJob.findUniqueOrThrow({ where: { id } })).state;
  const messageStatus = async (id: string) => (await db.chatMessage.findUniqueOrThrow({ where: { id } })).status;
  const stopAudits = (threadId: string) => db.auditEntry.count({ where: { key: 'thread.stop', resourceId: threadId } });

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: true, ownerEmail: null });
    db = fixtureDb(app);
    world = await seedFleetHttpWorld(server(), db);
    app.get<IFleetConfig>(FLEET_CFG).threadsEnabled = true;
    agent = await seedFleetHttpAgent(server(), world.tokens.root);
    await grantKeys(db, { type: 'USER', id: world.ids.root }, ['project.read', 'thread.stop'], world.projectId);
    await grantKeys(db, { type: 'AGENT', id: agent.id }, ['project.read', 'thread.stop'], world.projectId);
    await app.get(PermissionCache).invalidate();
  }, 60_000);
  afterAll(async () => { await app?.close(); });
  beforeEach(async () => {
    resetThrottle(app);
    await db.approvalDecision.deleteMany();
    await db.approvalRequest.deleteMany();
    await db.approvalPolicy.deleteMany();
  });

  it('cancels a queued project-thread turn, errors its pending message, audits the stop and writes no command', async () => {
    const { id } = await thread('REPO');
    const { job, message } = await turn(id, 'QUEUED');
    await request(server()).post(`/api/projects/web/threads/${id}/stop`).set(auth()).expect(200);
    expect(await jobState(job.id)).toBe('CANCELLED');
    expect(await messageStatus(message.id)).toBe('errored');
    expect(await db.fleetCommand.count({ where: { jobId: job.id } })).toBe(0);
    expect(await stopAudits(id)).toBe(1);
  });

  it('cancels a queued workspace-thread turn the same way', async () => {
    const { id } = await thread('WORKSPACE');
    const { job, message } = await turn(id, 'QUEUED');
    await request(server()).post(`/api/threads/${id}/stop`).set(auth()).expect(200);
    expect(await jobState(job.id)).toBe('CANCELLED');
    expect(await messageStatus(message.id)).toBe('errored');
    expect(await stopAudits(id)).toBe(1);
  });

  it('cancels an ASSIGNED turn whose ASSIGN the runner never acked', async () => {
    const { id } = await thread('REPO');
    const { job } = await turn(id, 'ASSIGNED');
    await request(server()).post(`/api/projects/web/threads/${id}/stop`).set(auth()).expect(200);
    expect(await jobState(job.id)).toBe('CANCELLED');
  });

  it('leaves an ASSIGNED turn the runner acked alone and answers noSession', async () => {
    const { id } = await thread('REPO');
    const { job } = await turn(id, 'ASSIGNED', { acked: true });
    await request(server()).post(`/api/projects/web/threads/${id}/stop`).set(auth()).expect(409);
    expect(await jobState(job.id)).toBe('ASSIGNED');
  });

  it.each(['PUBLISH', 'DISCARD'] as const)('never cancels a queued %s job: it keeps answering noSession', async (action) => {
    const { id } = await thread('REPO');
    const { job } = await turn(id, 'QUEUED', { action });
    await request(server()).post(`/api/projects/web/threads/${id}/stop`).set(auth()).expect(409);
    expect(await jobState(job.id)).toBe('QUEUED');
    expect(await stopAudits(id)).toBe(0);
  });

  it('still sends a stop turn command to a running turn and leaves the job running', async () => {
    const { id } = await thread('REPO');
    const { job } = await turn(id, 'RUNNING');
    await request(server()).post(`/api/projects/web/threads/${id}/stop`).set(auth()).expect(200);
    expect(await jobState(job.id)).toBe('RUNNING');
    expect(await db.fleetCommand.count({ where: { jobId: job.id, type: 'THREAD_STOP_TURN' } })).toBe(1);
  });

  it('still answers 409 threads.noSession when the thread has no turn at all', async () => {
    const { id } = await thread('REPO');
    await request(server()).post(`/api/projects/web/threads/${id}/stop`).set(auth()).expect(409);
  });

  it('cancels a queued turn when an agent\'s gated stop is approved, inside the approval transaction', async () => {
    const { id } = await thread('REPO', agent.id);
    const { job } = await turn(id, 'QUEUED');
    await seedWaitPolicy(db, 'thread.stop', world.projectId);
    const ask = data<{ id: string }>(await request(server()).post(`/api/projects/web/threads/${id}/stop`).set(auth(agent.apiKey)).expect(202));
    const decided = data<{ status: string }>(await request(server()).post(`/api/approvals/${ask.id}/decisions`).set(auth()).send({ decision: 'approve' }).expect(200));
    expect(decided.status).toBe('executed');
    expect(await jobState(job.id)).toBe('CANCELLED');
  });
});
