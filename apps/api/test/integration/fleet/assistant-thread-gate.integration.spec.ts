import { pendingRequestId } from '../../helpers/assistant-request';
import request from 'supertest';
import type { NathApplication } from '@nathapp/nestjs-app';
import type { PrismaClient } from '../../../src/generated/prisma/client';
import { ThreadEventBus } from '../../../src/live/thread-event-bus';
import { grantBaseline, grantRole } from '../../../src/permissions/test-helpers/permission-fixtures';
import { canRunDbTests } from '../../helpers/test-environment';
import { bootHttpApp, data } from '../../helpers/http-app';
import { fixtureDb } from '../../helpers/action-context';
import { resetDb } from '../../helpers/reset-db';
import { enrollRunner, seedFleetHttpWorld, type FleetHttpWorld } from '../../helpers/fleet-fixtures';
import { seedThreadJobFor, type ThreadJobSeed } from '../../helpers/thread-fixtures';

const integration = canRunDbTests() ? describe : describe.skip;
integration('waiting assistant thread writes through ApprovalGate (PG)', () => {
  let app: NathApplication;
  let db: PrismaClient;
  let world: FleetHttpWorld;
  let runner: { runnerId: string; apiKey: string };
  let seed: ThreadJobSeed;
  let saved: string | undefined;
  let seq = 0;
  const call = async (id: string, input: unknown, tool = 'koda_add_comment', jobId = seed.jobId) => data<{ content: string; isError: boolean }>(await request(app.getHttpServer())
    .post(`/api/fleet/runner/jobs/${jobId}/tools/${tool}?leaseEpoch=1`).set('Authorization', `Bearer ${runner.apiKey}`).send({ toolCallId: id, input }).expect(200));
  const args = { ref: 'WEB-1', body: 'hello' };
  const requestId = pendingRequestId;
  beforeAll(async () => {
    saved = process.env.FLEET_THREADS_ENABLED; process.env.FLEET_THREADS_ENABLED = 'true';
    await resetDb(); app = await bootHttpApp({ registrationEnabled: false }); db = fixtureDb(app);
    world = await seedFleetHttpWorld(app.getHttpServer(), db);
    runner = await enrollRunner(app.getHttpServer(), world.tokens.root, 'thread-gate-runner');
    await db.runner.update({ where: { id: runner.runnerId }, data: { protocolVersion: 4, enabled: true, lastSeenAt: new Date() } });
    await db.ticket.create({ data: { projectId: world.projectId, number: 1, title: 'Gate ticket', type: 'BUG', status: 'CREATED', priority: 'HIGH' } });
  }, 120_000);
  beforeEach(async () => { seed = await seedThreadJobFor(db, world, runner, { feature: `gate-${++seq}` }); });
  afterAll(async () => { try { await app?.close(); } finally { if (saved === undefined) delete process.env.FLEET_THREADS_ENABLED; else process.env.FLEET_THREADS_ENABLED = saved; } });
  afterEach(() => vi.restoreAllMocks());

  it('AC-1,2,3,4,5: opens an attributed human request, links its preview and publishes only committed rows', async () => {
    const bus = vi.spyOn(app.get(ThreadEventBus, { strict: false }), 'publish');
    const answer = await call('open', args);
    const id = requestId(answer.content);
    const row = await db.approvalRequest.findUniqueOrThrow({ where: { id } });
    expect(row).toMatchObject({ permissionKey: 'comment.create', projectId: world.projectId, actorType: 'SYSTEM', actorId: 'assistant', onBehalfOfType: 'USER', onBehalfOfId: world.ids.dev, origin: 'thread', requiredMode: 'human', status: 'pending', input: { projectId: world.projectId, threadId: seed.threadId, jobId: seed.jobId, args } });
    expect(await db.comment.count()).toBe(0);
    expect(answer).toEqual({ content: `pending ${id}: awaiting approval; do not retry`, isError: false });
    expect(await db.assistantActionRequest.findUniqueOrThrow({ where: { requestId: id } })).toMatchObject({ requestId: id, threadId: seed.threadId, jobId: seed.jobId, toolCallId: 'open', tool: 'koda_add_comment', preview: 'Add a comment to WEB-1 "Gate ticket":\n\nhello' });
    expect(bus).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ type: 'thread', threadId: seed.threadId }));
    expect(await db.fleetApproval.count({ where: { type: 'assistant_action' } })).toBe(0);
  });
  it('AC-6: refuses at ten before duplicate lookup', async () => {
    for (let i = 0; i < 10; i++) expect((await call(`slot-${i}`, { ...args, body: `body-${i}` })).isError).toBe(false);
    const count = await db.approvalRequest.count();
    expect(await call('overflow', { ...args, body: 'body-0' })).toEqual({ content: 'refused: 10 actions are pending in this thread; wait for the user to decide them', isError: true });
    expect(await db.approvalRequest.count()).toBe(count);
  });
  it('AC-7: another call id with identical input returns the first request without a second link', async () => {
    const first = await call('first', args); const before = await db.approvalRequest.count();
    expect(await call('second', args)).toEqual(first);
    expect(await db.approvalRequest.count()).toBe(before);
    expect(await db.assistantActionRequest.count({ where: { threadId: seed.threadId } })).toBe(1);
  });
  it('AC-8: an agent requester waits with assistant actor and agent onBehalfOf', async () => {
    const agent = await db.agent.create({ data: { name: 'Gate agent', slug: 'gate-agent', status: 'ACTIVE', apiKeyHash: 'gate-agent-hash' } });
    await grantBaseline(db, { type: 'AGENT', id: agent.id }); await grantRole(db, { type: 'AGENT', id: agent.id }, 'developer', world.projectId);
    await db.fleetJob.update({ where: { id: seed.jobId }, data: { requestedById: agent.id, requestedByType: 'AGENT' } });
    const answer = await call('agent', args);
    expect(await db.approvalRequest.findUniqueOrThrow({ where: { id: requestId(answer.content) } })).toMatchObject({ actorType: 'SYSTEM', actorId: 'assistant', onBehalfOfType: 'AGENT', onBehalfOfId: agent.id, requiredMode: 'human', status: 'pending' });
  });
  it('AC-13,14: thread reads are scoped and print the request timestamp', async () => {
    const answer = await call('open', args); const id = requestId(answer.content);
    const row = await db.approvalRequest.findUniqueOrThrow({ where: { id } });
    expect(await call('read', { id }, 'koda_get_action')).toEqual({ content: `action ${id} koda_add_comment pending\nrequested ${row.createdAt.toISOString()}`, isError: false });
    const other = await seedThreadJobFor(db, world, runner, { feature: `gate-other-${seq}` });
    expect(await call('foreign', { id }, 'koda_get_action', other.jobId)).toEqual({ content: 'not_found', isError: true });
  });
});
