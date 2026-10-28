import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import request from 'supertest';
import type { NathApplication } from '@nathapp/nestjs-app';
import { grantKeys } from '../../../src/approvals/test-helpers/approval-fixtures';
import { PermissionCache } from '../../../src/permissions/permission-cache';
import { fixtureDb } from '../../helpers/action-context';
import { bootHttpApp, data, resetThrottle } from '../../helpers/http-app';
import { seedFleetHttpAgent, seedFleetHttpWorld, type FleetHttpWorld } from '../../helpers/fleet-fixtures';
import { resetDb } from '../../helpers/reset-db';
import { canRunDbTests } from '../../helpers/test-environment';

/**
 * US-004 — the three role writes are approval-gated REST routes.
 *
 * One booted application for the whole file. `root` is the installation's Owner (the first
 * registration), and the agent holds `role.manage` and `role.read` globally: a GLOBAL role can carry
 * only global keys, and `createRole` checks escalation at the global scope. The `root` token is also
 * the decider — it holds `approval.decide` and `role.manage` globally — so every approval below is a
 * real `POST /approvals/:id/decisions`, never a direct service call.
 *
 * Run: cd apps/api && bun run test:db:up && bun run test:scoped test/integration/permissions/gated-role-routes.integration.spec.ts
 */
const describeIntegration = canRunDbTests() ? describe : describe.skip;

/** `permissions.40003`, the sentence a refused permission key carries. */
const PERMISSIONS_REFUSED = (
  JSON.parse(readFileSync(join(__dirname, '../../../src/i18n/en/permissions.json'), 'utf8')) as Record<string, string>
)['40003'];

const CREATE_BODY = { key: 'qa', name: 'QA', scope: 'GLOBAL', permissions: ['role.read'] };

/** The page of a 202 answer: the pending request summary. */
interface PendingSummary {
  id: string;
  permissionKey: string;
  status: string;
  requiredMode: string;
  actorType: string;
  actorId: string;
}

/** The page of an approval decision: the request with its result and decisions. */
interface DecidedRequest {
  id: string;
  status: string;
  result: unknown;
}

describeIntegration('gated role routes (US-004)', () => {
  let app: NathApplication;
  let db: ReturnType<typeof fixtureDb>;
  let world: FleetHttpWorld;
  let agent: Awaited<ReturnType<typeof seedFleetHttpAgent>>;
  /** An agent with its baseline binding only: no `role.manage` anywhere. */
  let stranger: Awaited<ReturnType<typeof seedFleetHttpAgent>>;

  const server = () => app.getHttpServer();
  const agentAuth = () => ({ Authorization: `Bearer ${agent.apiKey}` });
  const rootAuth = () => ({ Authorization: `Bearer ${world.tokens.root}` });

  const postRole = (body: object, auth: Record<string, string> = agentAuth()) =>
    request(server()).post('/api/roles').set(auth).send(body);
  const patchRole = (id: string, body: object) =>
    request(server()).patch(`/api/roles/${id}`).set(agentAuth()).send(body);
  const deleteRole = (id: string) => request(server()).delete(`/api/roles/${id}`).set(agentAuth());

  /** The 202 body read as the pending summary, with the status asserted once. */
  const pending = (res: request.Response): PendingSummary => {
    expect(res.status).toBe(202);
    return data<PendingSummary>(res);
  };

  /** The root's approval of one pending request, answered as the settled request. */
  const approve = async (id: string): Promise<DecidedRequest> => {
    const res = await request(server())
      .post(`/api/approvals/${id}/decisions`)
      .set(rootAuth())
      .send({ decision: 'approve' })
      .expect(200);
    return data<DecidedRequest>(res);
  };

  /** A role created by the root user, which executes at once (a human satisfies every mode). */
  const createAsRoot = async (body: object): Promise<{ id: string; key: string }> => {
    const res = await postRole(body, rootAuth()).expect(201);
    return data<{ id: string; key: string }>(res);
  };

  const auditRows = (roleId: string) =>
    db.auditEntry.findMany({ where: { resourceType: 'role', resourceId: roleId }, orderBy: { createdAt: 'asc' } });

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: true, ownerEmail: null });
    db = fixtureDb(app);
    world = await seedFleetHttpWorld(server(), db);
    agent = await seedFleetHttpAgent(server(), world.tokens.root);
    stranger = await seedFleetHttpAgent(server(), world.tokens.root);
    // A GLOBAL role can carry only global keys, and the create route checks escalation globally.
    await grantKeys(db, { type: 'AGENT', id: agent.id }, ['role.manage', 'role.read'], null);
    await app.get(PermissionCache).invalidate();
  }, 60_000);

  afterAll(async () => {
    await app?.close();
  });

  beforeEach(async () => {
    resetThrottle(app);
    await db.approvalDecision.deleteMany();
    await db.approvalRequest.deleteMany();
    await db.approvalPolicy.deleteMany();
    // A role written by an earlier test: every unbound custom role is this file's. The fixture grants
    // (`test-*` roles) keep their binding, so they survive.
    await db.role.deleteMany({ where: { system: false, bindings: { none: {} } } });
  });

  it('AC-1: the agent POST answers 202', async () => {
    const res = await postRole(CREATE_BODY);

    expect(res.status).toBe(202);
    expect(res.body.ret).toBe(0);
  });

  it('AC-2: the pending summary names role.manage, the human mode and the agent', async () => {
    const body = pending(await postRole(CREATE_BODY));

    expect(body).toMatchObject({
      permissionKey: 'role.manage',
      status: 'pending',
      requiredMode: 'human',
      actorType: 'AGENT',
      actorId: agent.id,
    });
  });

  it('AC-3: no role with key qa exists while the request waits', async () => {
    pending(await postRole(CREATE_BODY));

    expect(await db.role.findUnique({ where: { key: 'qa' } })).toBeNull();
  });

  it('AC-4: approving creates the role and the request is executed', async () => {
    const { id } = pending(await postRole(CREATE_BODY));

    const decided = await approve(id);

    expect(decided.status).toBe('executed');
    expect(await db.role.findUniqueOrThrow({ where: { key: 'qa' } })).toMatchObject({ key: 'qa', name: 'QA', scope: 'GLOBAL' });
  });

  it('AC-5: the executed request stores the role DTO as its result', async () => {
    const { id } = pending(await postRole(CREATE_BODY));
    await approve(id);

    const res = await request(server()).get(`/api/approvals/${id}`).set(rootAuth()).expect(200);
    expect(data<DecidedRequest>(res)).toMatchObject({ status: 'executed', result: { key: 'qa', name: 'QA' } });
  });

  it('AC-6: the audit entry attributes the create to the agent, approved by the root', async () => {
    const { id } = pending(await postRole(CREATE_BODY));
    await approve(id);
    const role = await db.role.findUniqueOrThrow({ where: { key: 'qa' } });

    expect(await auditRows(role.id)).toMatchObject([{
      actorType: 'AGENT',
      actorId: agent.id,
      key: 'role.manage',
      satisfiedBy: 'human',
      approverType: 'USER',
      approverId: world.ids.root,
      approvalRequestId: id,
    }]);
  });

  it('AC-7: the root POST answers 201 with the role and opens no request', async () => {
    const res = await postRole(CREATE_BODY, rootAuth());

    expect(res.status).toBe(201);
    const role = await db.role.findUniqueOrThrow({ where: { key: 'qa' } });
    expect(data<{ id: string; key: string; name: string }>(res)).toMatchObject({ id: role.id, key: 'qa', name: 'QA' });
    expect(await db.approvalRequest.count()).toBe(0);
  });

  it('AC-8: the root create is audited as a human write by the root', async () => {
    const role = await createAsRoot(CREATE_BODY);

    expect(await auditRows(role.id)).toMatchObject([{
      actorType: 'USER',
      actorId: world.ids.root,
      key: 'role.manage',
      requiredMode: 'human',
      satisfiedBy: 'human',
      approverType: 'USER',
      approverId: world.ids.root,
    }]);
  });

  it('AC-9: an agent without role.manage is refused with permissions and opens no request', async () => {
    const res = await postRole(CREATE_BODY, { Authorization: `Bearer ${stranger.apiKey}` });

    expect(res.status).toBe(403);
    expect(res.body.ret).toBe(40003);
    expect(res.body.message).toBe(PERMISSIONS_REFUSED);
    expect(await db.approvalRequest.count()).toBe(0);
    expect(await db.role.findUnique({ where: { key: 'qa' } })).toBeNull();
  });

  it('AC-10: PATCH answers 202 and, once approved, the role is renamed', async () => {
    const role = await createAsRoot({ key: 'qa-patch', name: 'QA', scope: 'GLOBAL', permissions: ['role.read'] });

    const res = await patchRole(role.id, { name: 'Renamed' });
    const summary = pending(res);
    expect(summary).toMatchObject({ permissionKey: 'role.manage', status: 'pending' });
    expect((await db.role.findUniqueOrThrow({ where: { id: role.id } })).name).toBe('QA');

    await approve(summary.id);

    expect((await db.role.findUniqueOrThrow({ where: { id: role.id } })).name).toBe('Renamed');
  });

  it('AC-11: DELETE answers 202 pending and, once approved, the role is gone', async () => {
    const role = await createAsRoot({ key: 'qa-delete', name: 'QA', scope: 'GLOBAL', permissions: ['role.read'] });

    const res = await deleteRole(role.id);
    const summary = pending(res);
    expect(summary.status).toBe('pending');
    expect(await db.role.findUnique({ where: { id: role.id } })).not.toBeNull();

    await approve(summary.id);

    expect(await db.role.findUnique({ where: { id: role.id } })).toBeNull();
  });

  it('AC-12: an approved escalation settles failed and creates no role', async () => {
    const { id } = pending(await postRole({
      key: 'qa-project', name: 'QA Project', scope: 'PROJECT', permissions: ['project.delete'],
    }));

    const decided = await approve(id);

    expect(decided.status).toBe('failed');
    expect((decided.result as { name?: string }).name).toBe('ForbiddenAppException');
    expect(await db.role.findUnique({ where: { key: 'qa-project' } })).toBeNull();
  });
});
