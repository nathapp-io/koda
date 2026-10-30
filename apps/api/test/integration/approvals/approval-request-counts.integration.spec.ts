import { randomUUID } from 'node:crypto';
import request from 'supertest';
import type { NathApplication } from '@nathapp/nestjs-app';
import { grantRole } from '../../../src/permissions/test-helpers/permission-fixtures';
import { PermissionCache } from '../../../src/permissions/permission-cache';
import { fixtureDb } from '../../helpers/action-context';
import { bootHttpApp, data, loginToken, resetThrottle, TEST_PASSWORD } from '../../helpers/http-app';
import { seedFleetHttpAgent, seedFleetHttpWorld, type FleetHttpWorld } from '../../helpers/fleet-fixtures';
import { resetDb } from '../../helpers/reset-db';
import { canRunDbTests } from '../../helpers/test-environment';

(canRunDbTests() ? describe : describe.skip)('Approval counts and job filtering through HTTP', () => {
  let app: NathApplication;
  let db: ReturnType<typeof fixtureDb>;
  let world: FleetHttpWorld;
  let approverToken: string;
  let outsiderToken: string;
  let agent: Awaited<ReturnType<typeof seedFleetHttpAgent>>;
  let a: string;
  let b: string;
  const server = () => app.getHttpServer();
  const get = (path: string, token = world.tokens.root) => request(server()).get(`/api/approvals${path}`).set('Authorization', `Bearer ${token}`);
  const insert = (projectId: string | null, actorId = randomUUID(), status = 'pending', permissionKey = 'agent.create') => db.approvalRequest.create({ data: {
    permissionKey, projectId, actorType: 'AGENT', actorId, status, origin: 'rest', correlationId: randomUUID(),
    input: {}, inputHash: randomUUID(), requiredMode: 'human', onTimeout: 'reject',
    approverMustHoldAction: true, requireDistinctApprover: false, expiresAt: new Date(Date.now() + 86_400_000),
  } });
  const expected = () => ({ total: 4, unscoped: 1, projects: [{ projectId: a, slug: 'a-proj', pending: 2 }, { projectId: b, slug: 'b-proj', pending: 1 }] });
  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: true });
    db = fixtureDb(app);
    world = await seedFleetHttpWorld(server(), db);
  });
  afterAll(async () => { await app?.close(); });
  beforeEach(async () => {
    resetThrottle(app);
    await db.approvalRequest.deleteMany();
    // Keep the required slugs stable while each test owns fresh project ids.
    for (const slug of ['a-proj', 'b-proj']) {
      await db.project.updateMany({ where: { slug }, data: { slug: randomUUID() } });
    }
    a = randomUUID(); b = randomUUID();
    for (const [id, slug] of [[a, 'a-proj'], [b, 'b-proj']]) await db.project.create({ data: { id, slug, key: id, name: slug } });
    const createUser = async () => {
      const email = `${randomUUID()}@koda.test`;
      const res = await request(server()).post('/api/admin/users').set('Authorization', `Bearer ${world.tokens.root}`)
        .send({ email, name: 'Counts reader', password: TEST_PASSWORD, role: 'MEMBER' }).expect(201);
      return { id: data<{ id: string }>(res).id, token: await loginToken(server(), email) };
    };
    const approver = await createUser();
    approverToken = approver.token;
    outsiderToken = (await createUser()).token;
    agent = await seedFleetHttpAgent(server(), world.tokens.root);
    await grantRole(db, { type: 'USER', id: approver.id }, 'approver', a);
    await app.get(PermissionCache).invalidate();
    await insert(a, agent.id); await insert(a); await insert(b); await insert(null); await insert(a, randomUUID(), 'rejected');
  });
  it('AC-1: counts pending requests grouped and ordered by project slug', async () => {
    expect(data(await get('/counts').expect(200))).toEqual(expected());
  });
  it('AC-2: pending counts total equals the pending list total', async () => {
    const counts = data<{ total: number }>(await get('/counts').expect(200));
    expect(counts.total).toBe(data<{ total: number }>(await get('?status=pending').expect(200)).total);
  });
  it('AC-3: a project Approver sees only that project', async () => {
    expect(data(await get('/counts', approverToken).expect(200))).toEqual({ total: 2, unscoped: 0, projects: [expected().projects[0]] });
  });
  it('AC-4: an agent without decide permission sees its own request', async () => {
    expect(data(await get('/counts', agent.apiKey).expect(200))).toEqual({ total: 1, unscoped: 0, projects: [{ projectId: a, slug: 'a-proj', pending: 1 }] });
  });
  it('AC-5: missing project rows have null slugs sorted last; soft-deleted projects still count', async () => {
    const missing = randomUUID();
    await insert(missing);
    await db.project.update({ where: { id: a }, data: { deletedAt: new Date() } });
    expect(data(await get('/counts').expect(200))).toEqual({ ...expected(), total: 5, projects: [...expected().projects, { projectId: missing, slug: null, pending: 1 }] });
  });
  it('empty visibility returns zero counts', async () => {
    expect(data(await get('/counts', outsiderToken).expect(200))).toEqual({ total: 0, unscoped: 0, projects: [] });
  });
  it('on-behalf-of visibility counts requests without decide grants', async () => {
    const row = await insert(b);
    await db.approvalRequest.update({ where: { id: row.id }, data: { onBehalfOfType: 'AGENT', onBehalfOfId: agent.id } });
    expect(data(await get('/counts', agent.apiKey).expect(200))).toEqual({ total: 2, unscoped: 0, projects: [
      { projectId: a, slug: 'a-proj', pending: 1 }, { projectId: b, slug: 'b-proj', pending: 1 },
    ] });
  });
  it('null slugs are ordered by projectId', async () => {
    await insert('missing-z'); await insert('missing-a');
    expect(data(await get('/counts').expect(200))).toEqual({ ...expected(), total: 6, projects: [...expected().projects,
      { projectId: 'missing-a', slug: null, pending: 1 }, { projectId: 'missing-z', slug: null, pending: 1 },
    ] });
  });
  it('a 64-character jobId is accepted', async () => {
    expect(data(await get(`?jobId=${'j'.repeat(64)}`).expect(200))).toMatchObject({ total: 0, records: [] });
  });
  it('AC-6: missing credentials returns 401', async () => { await request(server()).get('/api/approvals/counts').expect(401); });
  it('AC-11: job filter selects only the two linked requests', async () => {
    const j = randomUUID(); const k = randomUUID();
    const first = await insert(a, randomUUID(), 'pending', 'fleet.job.shell.escalate');
    const second = await insert(a, randomUUID(), 'pending', 'fleet.job.shell.escalate');
    const other = await insert(b, randomUUID(), 'pending', 'fleet.job.shell.escalate');
    for (const [row, jobId] of [[first, j], [second, j], [other, k]] as const) {
      await db.fleetApprovalAsk.create({ data: { requestId: row.id, kind: 'bash', projectId: row.projectId, jobId } });
    }
    const page = data<{ total: number; records: { id: string }[] }>(await get(`?jobId=${j}`).expect(200));
    expect(page.total).toBe(2);
    expect(page.records.map(row => row.id).sort()).toEqual([first.id, second.id].sort());
  });
  it('AC-12: job filter cannot widen visibility', async () => {
    const j = randomUUID(); const row = await insert(b);
    await db.fleetApprovalAsk.create({ data: { requestId: row.id, kind: 'bash', projectId: b, jobId: j } });
    // The caller can see A, but that must not reveal B's job-linked request.
    expect(data<{ total: number }>(await get('?status=pending', approverToken).expect(200)).total).toBe(2);
    expect(data(await get(`?jobId=${j}`, approverToken).expect(200))).toMatchObject({ total: 0, records: [] });
  });
  it.each(['', 'j'.repeat(65)])('AC-13: invalid jobId %j returns 400', async (jobId) => {
    await get(`?jobId=${jobId}`).expect(400);
  });
});
