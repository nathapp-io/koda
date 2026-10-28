import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import request from 'supertest';
import type { NathApplication } from '@nathapp/nestjs-app';
import { ApprovalPolicyService } from '../../../src/approvals/approval-policy.service';
import { PERMISSION_CATALOG } from '../../../src/permissions/catalog';
import { grantKeys } from '../../../src/approvals/test-helpers/approval-fixtures';
import { grantRole } from '../../../src/permissions/test-helpers/permission-fixtures';
import { PermissionCache } from '../../../src/permissions/permission-cache';
import { fixtureDb, withTestActor } from '../../helpers/action-context';
import { bootHttpApp, data, loginToken, resetThrottle, TEST_PASSWORD } from '../../helpers/http-app';
import { seedFleetHttpAgent, seedFleetHttpWorld, type FleetHttpWorld } from '../../helpers/fleet-fixtures';
import { resetDb } from '../../helpers/reset-db';
import { canRunDbTests } from '../../helpers/test-environment';

(canRunDbTests() ? describe : describe.skip)('Global approval policy REST', () => {
  let app: NathApplication;
  let db: ReturnType<typeof fixtureDb>;
  let world: FleetHttpWorld;
  let projectAdminToken: string;
  let agent: Awaited<ReturnType<typeof seedFleetHttpAgent>>;
  const body = { permissionPattern: 'label.delete', appliesTo: { kind: 'type', principalType: 'AGENT' }, mode: 'human' } as const;
  const server = () => app.getHttpServer();
  const get = (suffix = '', token = world.tokens.root) => request(server()).get(`/api/approval-policies${suffix}`).set('Authorization', `Bearer ${token}`);
  const post = (payload: object = body, token = world.tokens.root) => request(server()).post('/api/approval-policies').set('Authorization', `Bearer ${token}`).send(payload);
  const create = (projectId: string | null) => withTestActor({ type: 'USER', id: world.ids.root }, () => app.get(ApprovalPolicyService).create({ ...body, projectId }));
  const sentence = (key: string, code: string, args: Record<string, string> = {}) => {
    const catalog = JSON.parse(readFileSync(join(__dirname, '../../../src/i18n/en/approvals.json'), 'utf8'));
    return Object.entries(args).reduce((text, [name, value]) => text.replace(`{${name}}`, value), catalog[key][code] as string);
  };
  beforeAll(async () => {
    await resetDb(); app = await bootHttpApp({ registrationEnabled: true }); db = fixtureDb(app);
    world = await seedFleetHttpWorld(server(), db);
  });
  afterAll(async () => { await app?.close(); });
  beforeEach(async () => {
    resetThrottle(app);
    await db.approvalDecision.deleteMany(); await db.approvalRequest.deleteMany(); await db.approvalPolicy.deleteMany();
    const email = `${randomUUID()}@koda.test`;
    const res = await request(server()).post('/api/admin/users').set('Authorization', `Bearer ${world.tokens.root}`).send({ email, name: 'Project admin', password: TEST_PASSWORD, role: 'MEMBER' }).expect(201);
    const id = data<{ id: string }>(res).id;
    await grantRole(db, { type: 'USER', id }, 'project-admin', world.projectId);
    projectAdminToken = await loginToken(server(), email);
    agent = await seedFleetHttpAgent(server(), world.tokens.root);
    await grantKeys(db, { type: 'AGENT', id: agent.id }, ['approval.policy.manage'], null);
    await app.get(PermissionCache).invalidate();
  });
  it('AC-1: list returns exactly global policies with a project policy present', async () => {
    const global = await create(null); await create(world.projectId);
    const page = data<{ records: { id: string; createdAt: string }[]; total: number }>(await get().expect(200));
    expect(page.records.map((row) => row.id)).toEqual([global.id]);
    expect(page.total).toBe(1); expect(page.records[0].createdAt).toBe(global.createdAt.toISOString());
  });
  it('AC-2: project-admin alone cannot read global policies', async () => { await get('', projectAdminToken).expect(403); });
  it('AC-3: keys include label.delete catalog metadata', async () => {
    const entry = PERMISSION_CATALOG.find(({ key }) => key === 'label.delete');
    if (!entry) throw new Error('label.delete missing from catalog');
    expect(data<{ keys: object[] }>(await get('/keys').expect(200)).keys).toContainEqual({ key: entry.key, scope: entry.scope, risk: entry.risk, floor: 'none', default: 'agent' });
  });
  it('AC-4: keys exclude label.read', async () => {
    expect(data<{ keys: { key: string }[] }>(await get('/keys').expect(200)).keys.some(({ key }) => key === 'label.read')).toBe(false);
  });
  it('AC-5: admin creates a global policy', async () => { expect(data(await post().expect(201))).toMatchObject({ projectId: null, permissionPattern: 'label.delete', mode: 'human' }); });
  it('AC-6: below floor is localized 400', async () => {
    const res = await post({ permissionPattern: 'role.manage', appliesTo: { kind: 'all' }, mode: 'none' }).expect(400);
    expect(res.body.message).toBe(sentence('invalidPolicy', '400', { violation: 'below-floor' }));
  });
  it('AC-7: duplicate is localized 409', async () => {
    await post().expect(201); const res = await post().expect(409);
    expect(res.body.message).toBe(sentence('policyConflict', '409'));
  });
  it('AC-8: bogus subject is 400', async () => { await post({ ...body, appliesTo: { kind: 'bogus' } }).expect(400); });
  it('AC-12: globally granted REST agent self-applying policy fails after approval', async () => {
    const opened = await post(body, agent.apiKey).expect(202);
    const requestId = opened.body.data.id as string;
    const decided = await request(server()).post(`/api/approvals/${requestId}/decisions`)
      .set('Authorization', `Bearer ${world.tokens.root}`).send({ decision: 'approve' }).expect(200);
    expect(decided.body.data.status).toBe('failed');
    expect(decided.body.data.result).toMatchObject({ name: 'ApprovalPolicySelfApplicationError' });
  });
  it('AC-15: service list retains its array contract', async () => {
    const global = await create(null); await create(world.projectId);
    const rows = await app.get(ApprovalPolicyService).list({ projectId: null }, { current: 1, size: 20 });
    expect(Array.isArray(rows)).toBe(true); expect(rows.map(({ id }) => id)).toEqual([global.id]);
  });
  it('validates pagination and filters without accepting projectId overrides', async () => {
    await create(null); await create(world.projectId);
    await get('?size=101').expect(400);
    expect(data<{ records: object[] }>(await get('?permissionPattern=role.manage').expect(200)).records).toEqual([]);
    expect(data<{ records: { projectId: string | null }[] }>(await get(`?projectId=${world.projectId}`).expect(200)).records.map(({ projectId }) => projectId)).toEqual([null]);
  });
  it('keys and create require global permission and authentication', async () => {
    await get('/keys', projectAdminToken).expect(403); await post(body, projectAdminToken).expect(403);
    await request(server()).get('/api/approval-policies').expect(401);
    await request(server()).get('/api/approval-policies/keys').expect(401);
    await request(server()).post('/api/approval-policies').send(body).expect(401);
  });
});
