import request from 'supertest';
import type { NathApplication } from '@nathapp/nestjs-app';
import { ForbiddenAppException } from '@nathapp/nestjs-common';
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

describeIntegration('gated comment write routes', () => {
  let app: NathApplication;
  let db: ReturnType<typeof fixtureDb>;
  let world: FleetHttpWorld;
  let agent: Awaited<ReturnType<typeof seedFleetHttpAgent>>;
  let keyless: Awaited<ReturnType<typeof seedFleetHttpAgent>>;
  let outsider: Awaited<ReturnType<typeof seedFleetHttpAgent>>;
  let project: { id: string; slug: string };
  let ticket: { id: string; ref: string };
  let counter = 0;
  const server = () => app.getHttpServer();
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
  const agentAuth = () => auth(agent.apiKey);
  const rootAuth = () => auth(world.tokens.root);
  const commentPath = () => `/api/projects/${project.slug}/tickets/${ticket.ref}/comments`;
  const pending = (res: request.Response) => { expect(res.status).toBe(202); return data<Pending>(res); };
  const approve = async (id: string) => data<Settled>(await request(server()).post(`/api/approvals/${id}/decisions`).set(rootAuth()).send({ decision: 'approve' }).expect(200));
  const createComment = async (body: string, token = world.tokens.root) => data<{ id: string }>(await request(server()).post(commentPath()).set(auth(token)).send({ body }).expect(201));

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: true, ownerEmail: null });
    db = fixtureDb(app);
    world = await seedFleetHttpWorld(server(), db);
    project = data(await request(server()).post('/api/projects').set(rootAuth()).send({ name: 'Comment gates', slug: 'comment-gates', key: 'CG' }).expect(201));
    agent = await seedFleetHttpAgent(server(), world.tokens.root);
    keyless = await seedFleetHttpAgent(server(), world.tokens.root);
    outsider = await seedFleetHttpAgent(server(), world.tokens.root);
    await grantKeys(db, { type: 'AGENT', id: agent.id }, ['project.read', 'comment.create', 'comment.update.own'], project.id);
    await grantKeys(db, { type: 'AGENT', id: keyless.id }, ['project.read'], project.id);
    await app.get(PermissionCache).invalidate();
  }, 60000);
  beforeEach(async () => {
    resetThrottle(app);
    await db.approvalDecision.deleteMany();
    await db.approvalRequest.deleteMany();
    await db.approvalPolicy.deleteMany();
    ticket = data(await request(server()).post(`/api/projects/${project.slug}/tickets`).set(rootAuth()).send({ type: 'BUG', title: `comment target ${++counter}` }).expect(201));
  });
  afterAll(async () => { await app?.close(); });

  it('AC-1: agent comment create waits and reports comment.create', async () => {
    await seedWaitPolicy(db, 'comment.create', project.id);
    const summary = pending(await request(server()).post(commentPath()).set(agentAuth()).send({ body: 'hi' }));
    expect(summary).toMatchObject({ permissionKey: 'comment.create', projectId: project.id });
    expect(await db.comment.count({ where: { ticketId: ticket.id } })).toBe(0);
  });

  it('AC-2: approving an independently submitted create stores its body and agent author', async () => {
    await seedWaitPolicy(db, 'comment.create', project.id);
    const summary = pending(await request(server()).post(commentPath()).set(agentAuth()).send({ body: 'hi' }));
    expect(await approve(summary.id)).toMatchObject({ status: 'executed' });
    expect(await db.comment.count({ where: { ticketId: ticket.id, body: 'hi', authorAgentId: agent.id } })).toBe(1);
  });

  it('AC-3: own-comment update waits under comment.update with the project scope', async () => {
    const own = await createComment(`own ${++counter}`, agent.apiKey);
    await seedWaitPolicy(db, 'comment.update', project.id);
    const summary = pending(await request(server()).patch(`/api/comments/${own.id}`).set(agentAuth()).send({ body: 'edited' }));
    expect(summary).toMatchObject({ permissionKey: 'comment.update', projectId: project.id });
  });

  it('AC-4: approving an independently submitted own-comment update persists edited body', async () => {
    const own = await createComment(`own ${++counter}`, agent.apiKey);
    await seedWaitPolicy(db, 'comment.update', project.id);
    const summary = pending(await request(server()).patch(`/api/comments/${own.id}`).set(agentAuth()).send({ body: 'edited' }));
    expect(await approve(summary.id)).toMatchObject({ status: 'executed' });
    expect((await db.comment.findUniqueOrThrow({ where: { id: own.id } })).body).toBe('edited');
  });

  it('AC-5: approved update of a root-authored comment fails and preserves its body', async () => {
    const original = `root comment ${++counter}`;
    const rootComment = await createComment(original);
    await seedWaitPolicy(db, 'comment.update', project.id);
    const summary = pending(await request(server()).patch(`/api/comments/${rootComment.id}`).set(agentAuth()).send({ body: 'not allowed' }));
    expect(await approve(summary.id)).toMatchObject({ status: 'failed', result: { error: 'execution-failed', name: new ForbiddenAppException({}, 'permissions').name } });
    expect((await db.comment.findUniqueOrThrow({ where: { id: rootComment.id } })).body).toBe(original);
  });

  it('AC-6: missing comment returns 404 before opening a request', async () => {
    const response = await request(server()).patch('/api/comments/missing').set(agentAuth()).send({ body: 'edited' });
    expect(response.status).toBe(404);
    expect(String(response.body.message).toLowerCase()).toContain('comment');
    expect(await db.approvalRequest.count()).toBe(0);
  });

  it('AC-7: non-member comment lookup is hidden as 404 before opening a request', async () => {
    const own = await createComment(`member ${++counter}`, agent.apiKey);
    const response = await request(server()).patch(`/api/comments/${own.id}`).set(auth(outsider.apiKey)).send({ body: 'edited' });
    expect(response.status).toBe(404);
    expect(String(response.body.message).toLowerCase()).toContain('comment');
    expect(await db.approvalRequest.count()).toBe(0);
  });

  it('AC-8: project.read alone cannot update and opens no request', async () => {
    const own = await createComment(`own ${++counter}`, agent.apiKey);
    const response = await request(server()).patch(`/api/comments/${own.id}`).set(auth(keyless.apiKey)).send({ body: 'edited' });
    expect(response.status).toBe(403);
    expect(response.body.ret).toBe(40003);
    expect(await db.approvalRequest.count()).toBe(0);
  });

  it('AC-9: root creates immediately under an agent wait policy', async () => {
    await seedWaitPolicy(db, 'comment.create', project.id);
    await request(server()).post(commentPath()).set(rootAuth()).send({ body: 'root direct' }).expect(201);
    expect(await db.approvalRequest.count()).toBe(0);
  });
});
