import request from 'supertest';
import type { NathApplication } from '@nathapp/nestjs-app';
import { grantKeys, seedWaitPolicy } from '../../../src/approvals/test-helpers/approval-fixtures';
import { PermissionCache } from '../../../src/permissions/permission-cache';
import { fixtureDb } from '../../helpers/action-context';
import { bootHttpApp, data, resetThrottle } from '../../helpers/http-app';
import { insertRunner, seedFleetHttpAgent, seedFleetHttpWorld, type FleetHttpWorld } from '../../helpers/fleet-fixtures';
import { seedFleetAsk } from '../../helpers/fleet-ask-fixtures';
import { resetDb } from '../../helpers/reset-db';
import { canRunDbTests } from '../../helpers/test-environment';
import enFleet from '../../../src/i18n/en/fleet.json';
import enPermissions from '../../../src/i18n/en/permissions.json';

const describeIntegration = canRunDbTests() ? describe : describe.skip;
interface Pending { id: string; permissionKey: string; projectId: string }
describeIntegration('gated project fleet approval decisions', () => {
  let app: NathApplication;
  let db: ReturnType<typeof fixtureDb>;
  let world: FleetHttpWorld;
  let agent: Awaited<ReturnType<typeof seedFleetHttpAgent>>;
  let viewer: Awaited<ReturnType<typeof seedFleetHttpAgent>>;
  let runner: { id: string };
  let sequence = 0;
  const server = () => app.getHttpServer();
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
  const decide = (id: string, token = agent.apiKey, decision = 'deny') => request(server())
    .post(`/api/projects/web/fleet/approvals/${id}/decide`).set(auth(token)).send({ decision });
  const row = (id: string) => db.approvalRequest.findUniqueOrThrow({ where: { id } });
  const approve = async (id: string) => data<{ status: string }>(await request(server())
    .post(`/api/approvals/${id}/decisions`).set(auth(world.tokens.root)).send({ decision: 'approve' }).expect(200));
  const bashAsk = async () => {
    const job = await db.fleetJob.create({ data: {
      projectId: world.projectId, repoId: world.repoId, ref: 'main', command: 'RUN', feature: `gated-decide-${++sequence}`,
      profiles: [], maxCostUsd: 5, selectorLabels: [], requestedById: world.ids.dev, requestedByType: 'USER',
      state: 'RUNNING', bashMode: 'escalate', runnerId: runner.id, leaseEpoch: 1, firstStartedAt: new Date(),
    } });
    const naxAskId = `ask-${sequence}`;
    return (await seedFleetAsk(db, {
      kind: 'bash', projectId: world.projectId, onBehalfOf: { type: 'USER', id: world.ids.dev },
      expiresAt: new Date(Date.now() + 300_000),
      input: { jobId: job.id, leaseEpoch: 1, naxAskId, payload: { command: 'bun run test', commandTruncated: false, options: ['allow', 'deny'] } },
      link: { jobId: job.id, leaseEpoch: 1, naxAskId },
    })).requestId;
  };
  const open = async (id: string) => data<Pending>(await decide(id).expect(202));
  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: true, ownerEmail: null });
    db = fixtureDb(app);
    world = await seedFleetHttpWorld(server(), db);
    agent = await seedFleetHttpAgent(server(), world.tokens.root);
    viewer = await seedFleetHttpAgent(server(), world.tokens.root);
    // Deliberately no fleet.approval.decide.bash: eligibility is the authority, not metadata.
    await grantKeys(db, { type: 'AGENT', id: agent.id }, ['project.read', 'approval.decide', 'fleet.job.shell.escalate'], world.projectId);
    await grantKeys(db, { type: 'AGENT', id: viewer.id }, ['project.read'], world.projectId);
    await app.get(PermissionCache).invalidate();
    runner = await insertRunner(db, { createdById: world.ids.root, enabled: false });
  }, 60_000);
  afterAll(async () => { await app?.close(); });
  beforeEach(async () => {
    resetThrottle(app);
    await db.fleetApprovalAsk.deleteMany();
    await db.approvalDecision.deleteMany();
    await db.approvalRequest.deleteMany();
    await db.approvalPolicy.deleteMany();
    await db.fleetCommand.deleteMany();
    await db.fleetJob.deleteMany();
    await seedWaitPolicy(db, 'fleet.approval.decide.bash', world.projectId);
  });
  it('AC-1: eligible agent deny opens a project-scoped type-key request', async () => {
    const id = await bashAsk();
    const pending = await open(id);
    expect(pending).toMatchObject({ permissionKey: 'fleet.approval.decide.bash', projectId: world.projectId });
    expect(await row(pending.id)).toMatchObject({ variant: 'rest:project-fleet-approvals.decide', input: { requestId: id, decision: 'reject', comment: null } });
  });
  it('AC-2: pending outer request leaves its own inner ask pending', async () => {
    const id = await bashAsk();
    await open(id);
    expect(await row(id)).toMatchObject({ status: 'pending' });
    expect(await db.approvalDecision.count({ where: { requestId: id } })).toBe(0);
  });
  it('AC-3: approval records the frozen inner reject', async () => {
    const id = await bashAsk();
    const pending = await open(id);
    expect(await approve(pending.id)).toMatchObject({ status: 'executed' });
    expect(await row(id)).toMatchObject({ status: 'rejected' });
    expect(await db.approvalDecision.findFirstOrThrow({ where: { requestId: id } })).toMatchObject({ decision: 'reject', comment: null, deciderId: agent.id });
  });
  it('AC-4: changed inner ask fails the outer request and keeps root decision', async () => {
    const id = await bashAsk();
    const pending = await open(id);
    await decide(id, world.tokens.root, 'allow').expect(200);
    expect(await approve(pending.id)).toMatchObject({ status: 'failed' });
    expect(await row(id)).toMatchObject({ status: 'executed', approverId: world.ids.root });
    expect(await db.approvalDecision.count({ where: { requestId: id } })).toBe(1);
  });
  it('AC-5: ineligible agent is forbidden and opens no request', async () => {
    const id = await bashAsk();
    const count = await db.approvalRequest.count();
    const res = await decide(id, viewer.apiKey).expect(403);
    expect(res.body).toMatchObject({ ret: 40003, message: enPermissions['40003'] });
    expect(await db.approvalRequest.count()).toBe(count);
  });
  it('AC-6: decided ask conflicts before opening a request', async () => {
    const id = await bashAsk();
    await decide(id, world.tokens.root).expect(200);
    const count = await db.approvalRequest.count();
    const res = await decide(id).expect(409);
    expect(res.body).toMatchObject({ ret: 409, message: enFleet.approvalNotPending['409'] });
    expect(await db.approvalRequest.count()).toBe(count);
  });
  it('AC-7: root deny bypasses policy without a new request', async () => {
    const id = await bashAsk();
    const count = await db.approvalRequest.count();
    await decide(id, world.tokens.root).expect(200);
    expect(await row(id)).toMatchObject({ status: 'rejected' });
    expect(await db.approvalRequest.count()).toBe(count);
  });
  it('AC-15: expired inner ask fails outer settlement without deciding it', async () => {
    const id = await bashAsk();
    const pending = await open(id);
    await db.approvalRequest.update({ where: { id }, data: { expiresAt: new Date(Date.now() - 1_000) } });
    expect(await approve(pending.id)).toMatchObject({ status: 'failed' });
    expect(await row(id)).toMatchObject({ status: 'pending' });
    expect(await db.approvalDecision.count({ where: { requestId: id } })).toBe(0);
  });
});
