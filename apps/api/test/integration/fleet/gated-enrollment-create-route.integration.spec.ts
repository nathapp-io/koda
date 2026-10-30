import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import request from 'supertest';
import type { NathApplication } from '@nathapp/nestjs-app';
import { APPROVAL_REDEEM_HEADER } from '../../../src/approvals/route/approval-gated.decorator';
import { grantKeys } from '../../../src/approvals/test-helpers/approval-fixtures';
import { PermissionCache } from '../../../src/permissions/permission-cache';
import { fixtureDb } from '../../helpers/action-context';
import { bootHttpApp, data, resetThrottle } from '../../helpers/http-app';
import { seedFleetHttpAgent, seedFleetHttpWorld, type FleetHttpWorld } from '../../helpers/fleet-fixtures';
import { resetDb } from '../../helpers/reset-db';
import { canRunDbTests } from '../../helpers/test-environment';

const describeIntegration = canRunDbTests() ? describe : describe.skip;
interface Pending { id: string; permissionKey: string; projectId: string | null; redeem: boolean }
interface Created { token: string; labels: string[] }

describeIntegration('gated runner enrollment creation', () => {
  let app: NathApplication;
  let db: ReturnType<typeof fixtureDb>;
  let world: FleetHttpWorld;
  let agent: Awaited<ReturnType<typeof seedFleetHttpAgent>>;
  const server = () => app.getHttpServer();
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
  const root = () => auth(world.tokens.root);
  const agentAuth = () => auth(agent.apiKey);
  const post = (labels: string[], redeem?: string) => {
    const call = request(server()).post('/api/fleet/enrollments').set(agentAuth()).send({ labels });
    return redeem === undefined ? call : call.set(APPROVAL_REDEEM_HEADER, redeem);
  };
  const pending = (response: request.Response) => {
    expect(response.status).toBe(202);
    return data<Pending>(response);
  };
  const approve = (id: string) => request(server()).post(`/api/approvals/${id}/decisions`).set(root()).send({ decision: 'approve' });
  const enrollmentCount = () => db.runnerEnrollment.count();
  const message = (key: string, status: string) => {
    const catalog = JSON.parse(readFileSync(join(__dirname, '../../../src/i18n/en/approvals.json'), 'utf8')) as Record<string, Record<string, string>>;
    return catalog[key][status];
  };

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: true, ownerEmail: null });
    db = fixtureDb(app);
    world = await seedFleetHttpWorld(server(), db);
    agent = await seedFleetHttpAgent(server(), world.tokens.root);
  }, 60_000);
  beforeEach(async () => {
    resetThrottle(app);
    await db.approvalDecision.deleteMany();
    await db.approvalRequest.deleteMany();
    await db.runnerEnrollment.deleteMany();
    await grantKeys(db, { type: 'AGENT', id: agent.id }, ['fleet.enrollment.create'], null);
    await app.get(PermissionCache).invalidate();
  });
  afterAll(async () => { await app?.close(); });

  it('AC-1: agent with the global key opens a pending redeem request without creating an enrollment', async () => {
    const summary = pending(await post(['gpu']).expect(202));
    expect(summary).toMatchObject({ permissionKey: 'fleet.enrollment.create', projectId: null, redeem: true });
    expect(await enrollmentCount()).toBe(0);
  });

  it('AC-2: the requester redeems its approved request and receives its one-time token', async () => {
    const summary = pending(await post(['gpu']));
    await approve(summary.id).expect(200);
    const result = data<Created>(await post(['gpu'], summary.id).expect(201));
    expect(result.token).toMatch(/^ke_/);
    expect(result.labels).toEqual(['gpu']);
    expect(await enrollmentCount()).toBe(1);
  });

  it('AC-3: the executed request stores input and token-free result', async () => {
    const summary = pending(await post(['gpu']));
    await approve(summary.id).expect(200);
    await post(['gpu'], summary.id).expect(201);
    const row = await db.approvalRequest.findUniqueOrThrow({ where: { id: summary.id } });
    expect(row.status).toBe('executed');
    expect(row.input).toEqual({ labels: ['gpu'] });
    expect(row.result).toMatchObject({ labels: ['gpu'] });
    expect(row.result).not.toHaveProperty('token');
  });

  it('AC-4: redemption with different labels mismatches without creating an enrollment', async () => {
    const summary = pending(await post(['gpu']));
    await approve(summary.id).expect(200);
    const response = await post(['cpu'], summary.id).expect(409);
    expect(response.body.message).toBe(message('redeemMismatch', '409'));
    expect(await enrollmentCount()).toBe(0);
  });

  it('AC-5: root creates immediately and opens no approval request', async () => {
    const response = await request(server()).post('/api/fleet/enrollments').set(root()).send({ labels: ['gpu'] }).expect(201);
    expect(data<Created>(response).token).toMatch(/^ke_/);
    expect(await db.approvalRequest.count()).toBe(0);
  });
});
