import { readFileSync } from 'node:fs';
import { join } from 'node:path';
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
interface Pending { id: string; permissionKey: string; redeem: boolean }
interface Settled { status: string }
interface Project { id: string; slug: string; name: string; ciWebhookToken: string | null }

describeIntegration('gated project CI token route (US-006)', () => {
  let app: NathApplication;
  let db: ReturnType<typeof fixtureDb>;
  let world: FleetHttpWorld;
  let agent: Awaited<ReturnType<typeof seedFleetHttpAgent>>;
  const server = () => app.getHttpServer();
  const projectPath = () => '/api/projects/web';
  const patchAgent = (patch: object, requestId?: string) => {
    const req = request(server()).patch(projectPath()).auth(agent.apiKey, { type: 'bearer' });
    if (requestId) req.set('X-Koda-Approval-Request', requestId);
    return req.send(patch);
  };
  const patchRoot = (patch: object) => request(server()).patch(projectPath()).auth(world.tokens.root, { type: 'bearer' }).send(patch);
  const currentProject = () => db.project.findUniqueOrThrow({ where: { id: world.projectId } });
  const readToken = () => request(server()).get(`${projectPath()}/ci-webhook-token`).auth(world.tokens.root, { type: 'bearer' });
  const pending = (response: request.Response) => data<Pending>(response);
  const message = (key: string, status: string) => {
    const catalog = JSON.parse(readFileSync(join(__dirname, '../../../src/i18n/en/approvals.json'), 'utf8')) as Record<string, Record<string, string>>;
    return catalog[key][status];
  };
  const approve = async (id: string) => data<Settled>(await request(server()).post(`/api/approvals/${id}/decisions`)
    .auth(world.tokens.root, { type: 'bearer' }).send({ decision: 'approve' }).expect(200));
  const redeem = (id: string, patch: object) => patchAgent(patch, id);

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: true, ownerEmail: null });
    db = fixtureDb(app);
    world = await seedFleetHttpWorld(server(), db);
    agent = await seedFleetHttpAgent(server(), world.tokens.root);
    await grantKeys(db, { type: 'AGENT', id: agent.id }, ['project.read', 'project.update'], world.projectId);
    await app.get(PermissionCache).invalidate();
  }, 60_000);
  afterAll(async () => { await app?.close(); });
  beforeEach(async () => {
    resetThrottle(app);
    await db.approvalDecision.deleteMany();
    await db.approvalRequest.deleteMany();
    await db.approvalPolicy.deleteMany();
    await patchRoot({ name: 'web', ciWebhookToken: null });
  });

  it('AC-1/2: waits without changing token and stores a redacted input', async () => {
    const token = 't'.repeat(32);
    await seedWaitPolicy(db, 'project.update', world.projectId);
    const requestInfo = pending(await patchAgent({ ciWebhookToken: token }).expect(202));
    expect(requestInfo).toMatchObject({ permissionKey: 'project.update', redeem: true });
    expect((await currentProject()).ciWebhookToken).toBeNull();
    const approval = data<{ input: { patch: { ciWebhookToken: string } } }>(await request(server()).get(`/api/approvals/${requestInfo.id}`)
      .auth(world.tokens.root, { type: 'bearer' }).expect(200));
    expect(approval.input.patch.ciWebhookToken).toBe('<redacted>');
  });

  it('AC-3/6: approval can be redeemed with the secret, but a different patch mismatches', async () => {
    const token = 't'.repeat(32);
    await seedWaitPolicy(db, 'project.update', world.projectId);
    const pendingRequest = pending(await patchAgent({ ciWebhookToken: token }).expect(202));
    await approve(pendingRequest.id);
    const mismatch = await redeem(pendingRequest.id, { name: 'Other', ciWebhookToken: token }).expect(409);
    expect(mismatch.body.message).toBe(message('redeemMismatch', '409'));
    expect(await currentProject()).toMatchObject({ ciWebhookToken: null });
    expect((await db.approvalRequest.findUniqueOrThrow({ where: { id: pendingRequest.id } })).status).toBe('approved');
    const done = data<Project>(await redeem(pendingRequest.id, { ciWebhookToken: token }).expect(200));
    expect(done.slug).toBe('web');
    expect(data<{ ciWebhookToken: string }>(await readToken().expect(200)).ciWebhookToken).toBe(token);
  });

  it('AC-4: root executes a mixed patch immediately despite the wait policy', async () => {
    const token = 't'.repeat(32);
    await seedWaitPolicy(db, 'project.update', world.projectId);
    const response = data<Project>(await patchRoot({ name: 'Renamed', ciWebhookToken: token }).expect(200));
    expect(response.name).toBe('Renamed');
    expect(await db.approvalRequest.count()).toBe(0);
    expect((await currentProject()).ciWebhookToken).toBe(token);
  });

  it('AC-5: agent mixed patch waits and executes both fields after approval', async () => {
    const token = 't'.repeat(32);
    await seedWaitPolicy(db, 'project.update', world.projectId);
    const waiting = pending(await patchAgent({ name: 'Renamed', ciWebhookToken: token }).expect(202));
    expect((await currentProject()).name).not.toBe('Renamed');
    await approve(waiting.id);
    await redeem(waiting.id, { name: 'Renamed', ciWebhookToken: token }).expect(200);
    expect(await currentProject()).toMatchObject({ name: 'Renamed', ciWebhookToken: token });
  });

  it('AC-7: ordinary updates remain deferred, even with a redemption header', async () => {
    await seedWaitPolicy(db, 'project.update', world.projectId);
    const waiting = pending(await patchAgent({ name: 'Plain' }, 'not-a-redemption').expect(202));
    expect(waiting).toMatchObject({ permissionKey: 'project.update', redeem: false });
    expect(await approve(waiting.id)).toMatchObject({ status: 'executed' });
    expect((await currentProject()).name).toBe('Plain');
  });

  it('AC-8: root can clear the token with null', async () => {
    await patchRoot({ ciWebhookToken: 't'.repeat(32) }).expect(200);
    await patchRoot({ ciWebhookToken: null }).expect(200);
    expect(data<{ ciWebhookToken: string | null }>(await readToken().expect(200)).ciWebhookToken).toBeNull();
  });

  it('FM-1: agent token patch executes immediately under the project.update default-none policy', async () => {
    const token = 't'.repeat(32);
    await patchAgent({ ciWebhookToken: token }).expect(200);
    expect((await currentProject()).ciWebhookToken).toBe(token);
    expect(await db.approvalRequest.count()).toBe(0);
  });
});
