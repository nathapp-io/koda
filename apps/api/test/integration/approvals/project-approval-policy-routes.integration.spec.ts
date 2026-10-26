import { randomUUID } from 'node:crypto';
import request from 'supertest';
import type { NathApplication } from '@nathapp/nestjs-app';
import { ApprovalPolicyService } from '../../../src/approvals/approval-policy.service';
import { grantKeys } from '../../../src/approvals/test-helpers/approval-fixtures';
import { grantRole } from '../../../src/permissions/test-helpers/permission-fixtures';
import { PermissionCache } from '../../../src/permissions/permission-cache';
import { fixtureDb, withTestActor } from '../../helpers/action-context';
import { bootHttpApp, data, loginToken, resetThrottle, TEST_PASSWORD } from '../../helpers/http-app';
import { seedFleetHttpWorld, type FleetHttpWorld } from '../../helpers/fleet-fixtures';
import { resetDb } from '../../helpers/reset-db';
import { canRunDbTests } from '../../helpers/test-environment';

(canRunDbTests() ? describe : describe.skip)('Project approval policy REST', () => {
  let app: NathApplication;
  let db: ReturnType<typeof fixtureDb>;
  let world: FleetHttpWorld;
  let adminToken: string;
  let viewerToken: string;
  let developerToken: string;
  let projectId: string;
  let otherProjectId: string;
  const body = { permissionPattern: 'label.delete', appliesTo: { kind: 'type', principalType: 'AGENT' }, mode: 'human' } as const;
  const server = () => app.getHttpServer();
  const path = () => '/api/projects/web/approval-policies';
  const get = (suffix = '', token = adminToken) => request(server()).get(`${path()}${suffix}`).set('Authorization', `Bearer ${token}`);
  const post = (token = adminToken) => request(server()).post(path()).set('Authorization', `Bearer ${token}`).send(body);
  const create = (scope: string | null) => withTestActor({ type: 'USER', id: world.ids.root }, () => app.get(ApprovalPolicyService).create({ ...body, projectId: scope }));

  beforeAll(async () => {
    await resetDb(); app = await bootHttpApp({ registrationEnabled: true }); db = fixtureDb(app);
    world = await seedFleetHttpWorld(server(), db); projectId = world.projectId; otherProjectId = world.opsProjectId;
    const email = `${randomUUID()}@koda.test`;
    resetThrottle(app);
    const response = await request(server()).post('/api/admin/users').set('Authorization', `Bearer ${world.tokens.root}`)
      .send({ email, name: 'Project admin', password: TEST_PASSWORD, role: 'MEMBER' }).expect(201);
    const id = data<{ id: string }>(response).id;
    await grantRole(db, { type: 'USER', id }, 'project-admin', projectId);
    adminToken = await loginToken(server(), email);
    viewerToken = world.tokens.viewer;
    developerToken = world.tokens.dev;
  });
  afterAll(async () => { await app?.close(); });
  beforeEach(async () => {
    resetThrottle(app); await db.approvalDecision.deleteMany(); await db.approvalRequest.deleteMany(); await db.approvalPolicy.deleteMany();
    await app.get(PermissionCache).invalidate();
  });

  it('AC-1, AC-10: project list and service pagination include only project and global rows', async () => {
    const local = await create(projectId); const global = await create(null); await create(otherProjectId);
    const response = data<{ records: { id: string }[] }>(await get().expect(200));
    expect(new Set(response.records.map(({ id }) => id))).toEqual(new Set([local.id, global.id]));
    const page = await app.get(ApprovalPolicyService).page({ projectIds: [projectId, null] }, { current: 1, size: 20 });
    expect(new Set(page.records.map(({ id }) => id))).toEqual(new Set([local.id, global.id]));
  });
  it('AC-11: legacy projectId filter remains unchanged', async () => {
    const local = await create(projectId); await create(null); await create(otherProjectId);
    const page = await app.get(ApprovalPolicyService).page({ projectId }, { current: 1, size: 20 });
    expect(page.records.map(({ id }) => id)).toEqual([local.id]);
  });
  it('AC-2/AC-3: any member can read, non-members are refused', async () => {
    await get('', viewerToken).expect(200);
    await get('', world.tokens.root).expect(200);
    await get('', world.tokens.outsider).expect(403);
  });
  it('AC-4/AC-5: only project admins create project policies', async () => {
    await post(developerToken).expect(403);
    expect(data<{ projectId: string }>(await post().expect(201)).projectId).toBe(projectId);
  });
  it('AC-6/AC-7: project update cannot target global or another project', async () => {
    const global = await create(null); const other = await create(otherProjectId);
    await request(server()).patch(`${path()}/${global.id}`).set('Authorization', `Bearer ${adminToken}`).send({ mode: 'agent' }).expect(404);
    await request(server()).patch(`${path()}/${other.id}`).set('Authorization', `Bearer ${adminToken}`).send({ mode: 'agent' }).expect(404);
  });
  it('AC-8/AC-14: deletion is project-scoped and succeeds only for project rows', async () => {
    const global = await create(null); const other = await create(otherProjectId); const local = await create(projectId);
    await request(server()).delete(`${path()}/${global.id}`).set('Authorization', `Bearer ${adminToken}`).expect(404);
    await request(server()).delete(`${path()}/${other.id}`).set('Authorization', `Bearer ${adminToken}`).expect(404);
    await request(server()).delete(`${path()}/${local.id}`).set('Authorization', `Bearer ${adminToken}`).expect(204);
  });
  it('AC-9: viewer can read approvable permission keys', async () => {
    const result = data<{ keys: { key: string }[] }>(await get('/keys', viewerToken).expect(200));
    expect(result.keys.map(({ key }) => key)).toContain('label.delete');
  });
  it('AC-10: projectIds permits global null and project rows while excluding other projects', async () => {
    const expected = [await create(projectId), await create(null)]; await create(otherProjectId);
    const page = await app.get(ApprovalPolicyService).page({ projectIds: [projectId, null] }, { current: 1, size: 20 });
    expect(new Set(page.records.map(({ id }) => id))).toEqual(new Set(expected.map(({ id }) => id)));
  });
});
