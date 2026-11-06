import request from 'supertest';
import type { NathApplication } from '@nathapp/nestjs-app';
import { Prisma, type PrismaClient } from '../../src/generated/prisma/client';
import { approvalInputHash, freezeApprovalInput } from '../../src/approvals/approval-input';
import { grantKeys } from '../../src/approvals/test-helpers/approval-fixtures';
import { PermissionCache } from '../../src/permissions/permission-cache';
import { fixtureDb } from '../helpers/action-context';
import { bootHttpApp, data, resetThrottle } from '../helpers/http-app';
import { resetDb } from '../helpers/reset-db';
import { seedFleetHttpAgent, seedFleetHttpWorld, rosterFleetAgent, type FleetHttpWorld } from '../helpers/fleet-fixtures';
import { canRunDbTests } from '../helpers/test-environment';

const integration = canRunDbTests() ? describe : describe.skip;
const sha = 'a'.repeat(40);
const shaOther = 'b'.repeat(40);
const flowStartInput = (flowId: string, specSha = sha) => ({ flowId, specSha });

integration('fleet flow start approval decision endpoint', () => {
  let app: NathApplication;
  let db: PrismaClient;
  let world: FleetHttpWorld;
  let agent: Awaited<ReturnType<typeof seedFleetHttpAgent>>;
  const server = () => app.getHttpServer();
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
  let flowId: string;
  let requestId: string;

  const seedFlowAndAsk = async (options: {
    state?: string;
    requestIdOnFlow?: string | null;
    flowSha?: string;
    requestSha?: string;
    onBehalfOf?: { type: 'USER'; id: string } | null;
  } = {}) => {
    const flow = await db.fleetFlow.create({
      data: {
        projectId: world.projectId, repoId: world.repoId, entry: 'NAX', createdByType: 'USER',
        createdById: options.onBehalfOf?.id ?? world.ids.dev, branch: 'feat/flow', specSha: options.flowSha ?? sha,
        reviewerRole: 'reviewer', supervisorRole: 'supervisor', costCapUsd: new Prisma.Decimal(5),
        state: options.state ?? 'PENDING', approvalRequestId: null,
        features: { create: [{ position: 0, feature: 'one', specPath: 'docs/one.md', dependsOn: [] }] },
      },
    });
    flowId = flow.id;
    const askInput = flowStartInput(flow.id, options.requestSha ?? sha);
    const frozen = freezeApprovalInput(askInput);
    const ask = await db.approvalRequest.create({
      data: {
        permissionKey: 'fleet.flow.start', projectId: world.projectId, actorType: 'SYSTEM', actorId: 'flow',
        onBehalfOfType: options.onBehalfOf?.type ?? null, onBehalfOfId: options.onBehalfOf?.id ?? null,
        origin: 'system', correlationId: `flow-${flow.id}`, input: frozen as Prisma.InputJsonValue,
        inputHash: approvalInputHash(frozen), requiredMode: 'human', onTimeout: 'reject',
        approverMustHoldAction: true, requireDistinctApprover: false,
        expiresAt: new Date(Date.now() + 60 * 60_000),
      },
    });
    requestId = ask.id;
    await db.fleetFlow.update({ where: { id: flow.id }, data: { approvalRequestId: options.requestIdOnFlow === undefined ? ask.id : options.requestIdOnFlow } });
  };

  const decide = (token: string, decision: 'approve' | 'reject' = 'approve') =>
    request(server()).post(`/api/approvals/${requestId}/decisions`).set(auth(token)).send({ decision });

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: true, ownerEmail: null });
    db = fixtureDb(app);
    world = await seedFleetHttpWorld(server(), db);
    agent = await seedFleetHttpAgent(server(), world.tokens.root);
    await rosterFleetAgent(db, agent.id, world.projectId);
    await grantKeys(db, { type: 'USER', id: world.ids.dev }, ['fleet.flow.start', 'approval.decide@fleet.flow.start'], world.projectId);
    await grantKeys(db, { type: 'AGENT', id: agent.id }, ['fleet.flow.start', 'approval.decide@fleet.flow.start'], world.projectId);
    await app.get(PermissionCache).invalidate();
  }, 60_000);
  afterAll(async () => { await app?.close(); });
  beforeEach(async () => {
    resetThrottle(app);
    await db.approvalDecision.deleteMany();
    await db.approvalRequest.deleteMany();
    await db.fleetFlowFeature.deleteMany();
    await db.fleetFlow.deleteMany();
    await db.auditEntry.deleteMany({ where: { key: 'fleet.flow.start' } });
    await db.fleetActivity.deleteMany({ where: { entityType: 'flow' } });
  });

  it('AC-3/4/5: approves and persists the decision, audit and activity', async () => {
    await seedFlowAndAsk();
    const response = await decide(world.tokens.root).expect(200);
    expect(data<{ status: string }>(response)).toMatchObject({ status: 'executed' });
    expect(await db.fleetFlow.findUniqueOrThrow({ where: { id: flowId } })).toMatchObject({
      state: 'APPROVED', approvalMode: 'REQUEST', approverId: world.ids.root, approvalRequestId: requestId,
    });
    expect(await db.auditEntry.findMany({ where: { key: 'fleet.flow.start', resourceType: 'flow', resourceId: flowId } }))
      .toMatchObject([{ key: 'fleet.flow.start', resourceType: 'flow', approverType: 'USER', approverId: world.ids.root, approvalRequestId: requestId }]);
    expect(await db.fleetActivity.findMany({ where: { action: 'flow.approved', entityId: flowId } }))
      .toMatchObject([{ action: 'flow.approved', entityType: 'flow', entityId: flowId, projectId: world.projectId }]);
  });

  it('AC-6: permits the on-behalf user to approve their own flow request', async () => {
    await seedFlowAndAsk({ onBehalfOf: { type: 'USER', id: world.ids.dev } });
    await decide(world.tokens.dev).expect(200);
    expect(await db.fleetFlow.findUniqueOrThrow({ where: { id: flowId } })).toMatchObject({ state: 'APPROVED', approverId: world.ids.dev });
  });

  it('AC-7: rejection stops the flow with an end time and approval_rejected reason', async () => {
    await seedFlowAndAsk();
    await decide(world.tokens.root, 'reject').expect(200);
    expect(await db.fleetFlow.findUniqueOrThrow({ where: { id: flowId } })).toMatchObject({ state: 'STOPPED', stopReason: 'approval_rejected', endedAt: expect.any(Date) });
    expect(await db.auditEntry.findMany({ where: { key: 'fleet.flow.start', resourceId: flowId } })).toHaveLength(1);
    expect(await db.fleetActivity.findMany({ where: { action: 'flow.stopped', entityId: flowId } })).toHaveLength(1);
  });

  it.each([
    ['AC-8', { state: 'STOPPED' }, 'STOPPED'],
    ['AC-9', { requestIdOnFlow: 'stale-request' }, 'PENDING'],
    ['AC-10', { flowSha: shaOther }, 'PENDING'],
  ])('%s: stale approval leaves the flow unchanged and returns applied false', async (_ac, options, state) => {
    await seedFlowAndAsk(options);
    await decide(world.tokens.root).expect(200);
    expect(await db.fleetFlow.findUniqueOrThrow({ where: { id: flowId } })).toMatchObject({ state });
    const row = await db.approvalRequest.findUniqueOrThrow({ where: { id: requestId } });
    expect(row.result).toMatchObject({ applied: false });
  });

  it('AC-11: refuses an agent decider and keeps the flow pending', async () => {
    await seedFlowAndAsk();
    await decide(agent.apiKey).expect(403);
    expect(await db.fleetFlow.findUniqueOrThrow({ where: { id: flowId } })).toMatchObject({ state: 'PENDING' });
  });

  it.each([
    ['superseded request', { requestIdOnFlow: 'superseded' }],
    ['flow already left PENDING', { state: 'APPROVED' }],
  ])('AC-14: rejection of %s leaves the flow unchanged', async (_case, options) => {
    await seedFlowAndAsk(options);
    await decide(world.tokens.root, 'reject').expect(200);
    expect(await db.fleetFlow.findUniqueOrThrow({ where: { id: flowId } })).toMatchObject({ state: options.state ?? 'PENDING' });
  });
});
