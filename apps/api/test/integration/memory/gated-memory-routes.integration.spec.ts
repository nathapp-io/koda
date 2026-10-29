import request from 'supertest';
import type { NathApplication } from '@nathapp/nestjs-app';
import { grantKeys, seedWaitPolicy } from '../../../src/approvals/test-helpers/approval-fixtures';
import { PermissionCache } from '../../../src/permissions/permission-cache';
import { fixtureDb } from '../../helpers/action-context';
import { bootHttpApp, data, resetThrottle } from '../../helpers/http-app';
import { seedFleetHttpAgent, seedFleetHttpWorld, type FleetHttpWorld } from '../../helpers/fleet-fixtures';
import { resetDb } from '../../helpers/reset-db';
import { canRunDbTests } from '../../helpers/test-environment';

const describeIntegration = canRunDbTests() ? describe : describe.skip;
interface Pending { id: string; permissionKey: string; projectId: string }
interface Settled { status: string; result: unknown }

describeIntegration('gated memory routes (US-007)', () => {
  let app: NathApplication;
  let db: ReturnType<typeof fixtureDb>;
  let world: FleetHttpWorld;
  let agent: Awaited<ReturnType<typeof seedFleetHttpAgent>>;
  let keyless: Awaited<ReturnType<typeof seedFleetHttpAgent>>;
  let project: { id: string; slug: string };
  let ticketId: string;
  let counter = 0;
  const server = () => app.getHttpServer();
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
  const rootAuth = () => auth(world.tokens.root);
  const agentAuth = () => auth(agent.apiKey);
  const pending = (res: request.Response) => { expect(res.status).toBe(202); return data<Pending>(res); };
  const approve = async (id: string) => data<Settled>(await request(server()).post(`/api/approvals/${id}/decisions`).set(rootAuth()).send({ decision: 'approve' }).expect(200));
  const unique = (prefix: string) => `${prefix}-${++counter}`;

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: true, ownerEmail: null });
    db = fixtureDb(app);
    world = await seedFleetHttpWorld(server(), db);
    project = data(await request(server()).post('/api/projects').set(rootAuth()).send({ name: 'Memory gates', slug: 'memory-gates', key: 'MG' }).expect(201));
    agent = await seedFleetHttpAgent(server(), world.tokens.root);
    keyless = await seedFleetHttpAgent(server(), world.tokens.root);
    await grantKeys(db, { type: 'AGENT', id: agent.id }, ['project.read', 'memory.create', 'memory.decision.record', 'memory.extract'], project.id);
    await grantKeys(db, { type: 'AGENT', id: keyless.id }, ['project.read'], project.id);
    await app.get(PermissionCache).invalidate();
  }, 60000);
  beforeEach(async () => {
    resetThrottle(app);
    await db.approvalDecision.deleteMany();
    await db.approvalRequest.deleteMany();
    await db.approvalPolicy.deleteMany();
    const ticket = await request(server()).post(`/api/projects/${project.slug}/tickets`).set(rootAuth()).send({ type: 'BUG', title: unique('memory ticket') }).expect(201);
    ticketId = data<{ id: string }>(ticket).id;
  });
  afterAll(async () => { await app?.close(); });

  const seedMemoryWait = () => seedWaitPolicy(db, 'memory.create', project.id);
  const subject = () => unique('memory-subject');

  it('AC-1: agent create waits with project-scoped memory.create metadata', async () => {
    await seedMemoryWait();
    const itemSubject = subject();
    const summary = pending(await request(server()).post('/api/memory').set(agentAuth()).send({ projectId: project.id, kind: 'FACT', subject: itemSubject, predicate: 'uses', object: 'bun' }));
    expect(summary).toMatchObject({ permissionKey: 'memory.create', projectId: project.id });
    expect(await db.memoryItem.count({ where: { projectId: project.id, subject: itemSubject } })).toBe(0);
  });

  it('AC-2: approving the pending create writes one active item owned by the agent', async () => {
    await seedMemoryWait();
    const itemSubject = subject();
    const summary = pending(await request(server()).post('/api/memory').set(agentAuth()).send({ projectId: project.id, kind: 'FACT', subject: itemSubject, predicate: 'uses', object: 'bun' }));
    expect(await approve(summary.id)).toMatchObject({ status: 'executed' });
    expect(await db.memoryItem.findMany({ where: { projectId: project.id, subject: itemSubject, predicate: 'uses', status: 'active' } })).toMatchObject([{ ownerId: agent.id, ownerType: 'AGENT' }]);
  });

  it('AC-3: approval executes the pending decision write', async () => {
    await seedWaitPolicy(db, 'memory.decision.record', project.id);
    const topic = unique('decision');
    const summary = pending(await request(server()).post('/api/memory/decisions').set(agentAuth()).send({ projectId: project.id, topic, decision: 'keep it simple' }));
    expect(summary).toMatchObject({ permissionKey: 'memory.decision.record', projectId: project.id });
    expect(await approve(summary.id)).toMatchObject({ status: 'executed' });
    expect(await db.memoryItem.count({ where: { projectId: project.id, kind: 'DECISION', subject: `agent:${agent.id}`, predicate: topic, status: 'active' } })).toBe(1);
  });

  it('AC-4: approval extracts the ticket status fact', async () => {
    await seedWaitPolicy(db, 'memory.extract', project.id);
    const summary = pending(await request(server()).post('/api/memory/extract').set(agentAuth()).send({ projectId: project.id, type: 'ticket_event', id: unique('event'), ticketId, action: 'status_changed', data: { newStatus: 'IN_PROGRESS' } }));
    expect(summary).toMatchObject({ permissionKey: 'memory.extract', projectId: project.id });
    expect(await approve(summary.id)).toMatchObject({ status: 'executed' });
    expect(await db.memoryItem.count({ where: { projectId: project.id, kind: 'FACT', subject: `ticket:${ticketId}`, predicate: 'status', status: 'active' } })).toBe(1);
  });

  it('AC-5: a concurrent active item makes approved create fail without superseding it', async () => {
    await seedMemoryWait();
    const itemSubject = subject();
    const summary = pending(await request(server()).post('/api/memory').set(agentAuth()).send({ projectId: project.id, kind: 'FACT', subject: itemSubject, predicate: 'uses', object: 'requested' }));
    await request(server()).post('/api/memory').set(rootAuth()).send({ projectId: project.id, kind: 'FACT', subject: itemSubject, predicate: 'uses', object: 'dev value' }).expect(201);
    const initial = await db.memoryItem.findFirstOrThrow({ where: { projectId: project.id, subject: itemSubject, predicate: 'uses', status: 'active' } });
    expect(await approve(summary.id)).toMatchObject({ status: 'failed' });
    expect(await db.memoryItem.findMany({ where: { projectId: project.id, subject: itemSubject, predicate: 'uses', status: 'active' } })).toMatchObject([{ id: initial.id, object: 'dev value' }]);
  });

  it('AC-6: an agent with only project.read is refused without opening an approval', async () => {
    await seedMemoryWait();
    const response = await request(server()).post('/api/memory').set(auth(keyless.apiKey)).send({ projectId: project.id, kind: 'FACT', subject: subject(), predicate: 'uses' });
    expect(response.status).toBe(403);
    expect(response.body.ret).toBe(40003);
    expect(await db.approvalRequest.count()).toBe(0);
  });

  it('AC-7: a user executes immediately under an agent wait policy', async () => {
    await seedMemoryWait();
    const itemSubject = subject();
    await request(server()).post('/api/memory').set(rootAuth()).send({ projectId: project.id, kind: 'FACT', subject: itemSubject, predicate: 'uses' }).expect(201);
    expect(await db.approvalRequest.count()).toBe(0);
    expect(await db.memoryItem.count({ where: { projectId: project.id, subject: itemSubject, status: 'active' } })).toBe(1);
  });
});
