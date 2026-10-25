import { canRunDbTests } from '../../helpers/test-environment';
import { NathApplication } from '@nathapp/nestjs-app';
import request from 'supertest';
import type { PrismaClient } from '../../../src/generated/prisma/client';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp, data } from '../../helpers/http-app';
import { enrollRunner, seedFleetHttpWorld, type FleetHttpWorld } from '../../helpers/fleet-fixtures';
import { seedThreadJobFor } from '../../helpers/thread-fixtures';
import { fixtureDb } from '../../helpers/action-context';
import { grantRole } from '../../../src/permissions/test-helpers/permission-fixtures';

const describeIntegration = canRunDbTests() ? describe : describe.skip;
vi.setConfig({ testTimeout: 30_000 });
const APPROVALS = '/api/projects/web/fleet/approvals';
const TOOL = 'koda_dispatch_job';

/** Real runner-tool proposal and requester approval, exercising API transactions and action-context propagation. */
describeIntegration('assistant fleet-tool audit entries (PG, US-006)', () => {
  let app: NathApplication;
  let prisma: PrismaClient;
  let world: FleetHttpWorld;
  let runnerKey: string;
  let heldJobId: string;
  let seq = 0;
  const savedThreads = process.env['FLEET_THREADS_ENABLED'];
  const server = () => app.getHttpServer();

  async function propose(feature: string, tool = TOOL, input: unknown = { repo: 'acme/app', command: 'RUN', feature, maxCostUsd: 0.5 }) {
    const toolCallId = `audit-assistant-${++seq}`;
    const response = await request(server())
      .post(`/api/fleet/runner/jobs/${heldJobId}/tools/${tool}?leaseEpoch=1`)
      .set({ Authorization: `Bearer ${runnerKey}` })
      .send({ toolCallId, input })
      .expect(200);
    expect(data<{ isError: boolean; content: string }>(response)).toMatchObject({ isError: false });
    const row = await prisma.pendingAction.findUniqueOrThrow({ where: { jobId_toolCallId: { jobId: heldJobId, toolCallId } } });
    return { actionId: row.id, approvalId: row.approvalId as string };
  }

  const decide = (approvalId: string, token: string, decision: 'approve' | 'reject') =>
    request(server()).post(`${APPROVALS}/${approvalId}/decide`).set({ Authorization: `Bearer ${token}` }).send({ decision });

  const seedRunJob = (feature: string, state: 'FAILED' | 'QUEUED') => prisma.fleetJob.create({
    data: {
      projectId: world.projectId, repoId: world.repoId, ref: 'trunk', command: 'RUN', feature,
      profiles: [], selectorLabels: ['no-such-label'], maxCostUsd: 0.5, requestedById: world.ids.dev,
      state, ...(state === 'FAILED' ? { finishedAt: new Date() } : {}),
    },
    select: { id: true },
  });

  beforeAll(async () => {
    process.env['FLEET_THREADS_ENABLED'] = 'true';
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    prisma = fixtureDb(app);
    world = await seedFleetHttpWorld(server(), prisma);
    const enrolled = await enrollRunner(server(), world.tokens.root, 'assistant-audit-runner');
    runnerKey = enrolled.apiKey;
    await prisma.runner.update({ where: { id: enrolled.runnerId }, data: { protocolVersion: 4, enabled: true, lastSeenAt: new Date() } });
    const held = await seedThreadJobFor(prisma, world, { runnerId: enrolled.runnerId, apiKey: runnerKey }, { feature: 'audit-held-thread' });
    heldJobId = held.jobId;
    await grantRole(prisma, { type: 'USER', id: world.ids.viewer }, 'developer', world.projectId);
  }, 120_000);

  afterAll(async () => {
    try { await app?.close(); } finally {
      if (savedThreads === undefined) delete process.env['FLEET_THREADS_ENABLED'];
      else process.env['FLEET_THREADS_ENABLED'] = savedThreads;
    }
  });

  it('AC-1, AC-5, AC-6 and AC-11: audits approve and inherits the approval context for one dispatch only', async () => {
    const feature = `audit-dispatch-${++seq}`;
    const { actionId, approvalId } = await propose(feature);
    const approvalEntry = () => prisma.auditEntry.findMany({ where: { resourceType: 'fleet-approval', resourceId: approvalId, key: 'fleet.approval.decide.assistant' } });

    await decide(approvalId, world.tokens.dev, 'approve').expect(200);
    const dispatch = await prisma.fleetJob.findFirstOrThrow({ where: { projectId: world.projectId, feature } });
    const decisions = await approvalEntry();
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({ key: 'fleet.approval.decide.assistant', resourceType: 'fleet-approval', resourceId: approvalId, projectId: world.projectId, actorType: 'USER', actorId: world.ids.dev, summary: 'decision: approve' });
    const writes = await prisma.auditEntry.findMany({ where: { resourceType: 'fleet-job', resourceId: dispatch.id, key: 'fleet.job.dispatch' } });
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ actorType: 'SYSTEM', actorId: 'assistant', onBehalfOfType: 'USER', onBehalfOfId: world.ids.dev, origin: 'thread', satisfiedBy: 'human', approverType: 'USER', approverId: world.ids.dev, approvalRequestId: actionId });
    const repeated = await decide(approvalId, world.tokens.dev, 'approve');
    expect(repeated.status).toBe(409);
    expect(await approvalEntry()).toHaveLength(1);
    expect(await prisma.auditEntry.count({ where: { projectId: world.projectId, key: 'fleet.job.dispatch', actorId: 'assistant' } })).toBe(1);
  });

  it('AC-7: approved requeue tool records the job write as SYSTEM/assistant', async () => {
    const job = await seedRunJob(`audit-requeue-${++seq}`, 'FAILED');
    const { approvalId } = await propose('unused', 'koda_requeue_job', { jobId: job.id });
    await decide(approvalId, world.tokens.dev, 'approve').expect(200);
    const entry = await prisma.auditEntry.findMany({ where: { resourceType: 'fleet-job', resourceId: job.id, key: 'fleet.job.requeue' } });
    expect(entry).toHaveLength(1);
    expect(entry[0]).toMatchObject({ actorType: 'SYSTEM', actorId: 'assistant' });
  });

  it('AC-8: approved cancel tool records the job write as SYSTEM/assistant', async () => {
    const job = await seedRunJob(`audit-cancel-${++seq}`, 'QUEUED');
    const { approvalId } = await propose('unused', 'koda_cancel_job', { jobId: job.id });
    await decide(approvalId, world.tokens.dev, 'approve').expect(200);
    const entry = await prisma.auditEntry.findMany({ where: { resourceType: 'fleet-job', resourceId: job.id, key: 'fleet.job.cancel' } });
    expect(entry).toHaveLength(1);
    expect(entry[0]).toMatchObject({ actorType: 'SYSTEM', actorId: 'assistant' });
  });

  it('AC-2: audits a rejected assistant approval without executing its tool', async () => {
    const { approvalId } = await propose(`audit-reject-${++seq}`);
    await decide(approvalId, world.tokens.dev, 'reject').expect(200);
    const entry = await prisma.auditEntry.findMany({ where: { resourceType: 'fleet-approval', resourceId: approvalId, key: 'fleet.approval.decide.assistant' } });
    expect(entry).toHaveLength(1);
    expect(entry[0]).toMatchObject({ actorType: 'USER', actorId: world.ids.dev, summary: 'decision: reject' });
    expect(await prisma.fleetJob.count({ where: { projectId: world.projectId, feature: `audit-reject-${seq}` } })).toBe(0);
  });

  it('AC-3: non-requester developer refusal does not create an assistant decision audit row', async () => {
    const { approvalId } = await propose(`audit-not-creator-${++seq}`);
    const response = await decide(approvalId, world.tokens.viewer, 'approve');
    expect(response.status).toBe(403);
    expect(await prisma.auditEntry.count({ where: { resourceType: 'fleet-approval', resourceId: approvalId, key: 'fleet.approval.decide.assistant' } })).toBe(0);
    expect(await prisma.fleetApproval.findUniqueOrThrow({ where: { id: approvalId } })).toMatchObject({ status: 'pending' });
  });

  it('AC-9: duplicate active dispatch keeps approval audited but records no assistant job dispatch', async () => {
    const feature = `audit-duplicate-${++seq}`;
    const { approvalId } = await propose(feature);
    const dispatchCount = await prisma.auditEntry.count({ where: { projectId: world.projectId, key: 'fleet.job.dispatch', actorType: 'SYSTEM', actorId: 'assistant' } });
    await prisma.fleetJob.create({
      data: {
        projectId: world.projectId, repoId: world.repoId, ref: 'trunk', command: 'RUN', feature,
        profiles: [], selectorLabels: [], maxCostUsd: 0.5, requestedById: world.ids.dev, state: 'QUEUED',
      },
    });

    await decide(approvalId, world.tokens.dev, 'approve').expect(200);
    expect(await prisma.fleetApproval.findUniqueOrThrow({ where: { id: approvalId } })).toMatchObject({ status: 'approved' });
    expect(await prisma.auditEntry.count({ where: { resourceType: 'fleet-approval', resourceId: approvalId, key: 'fleet.approval.decide.assistant' } })).toBe(1);
    expect(await prisma.auditEntry.count({ where: { projectId: world.projectId, key: 'fleet.job.dispatch', actorType: 'SYSTEM', actorId: 'assistant' } })).toBe(dispatchCount);
  });

  it('AC-4: expired assistant actions return 409 without a decision audit row', async () => {
    const { actionId, approvalId } = await propose(`audit-expired-${++seq}`);
    await prisma.pendingAction.update({ where: { id: actionId }, data: { expiresAt: new Date(Date.now() - 60_000) } });
    const response = await decide(approvalId, world.tokens.dev, 'approve');
    expect(response.status).toBe(409);
    expect(await prisma.auditEntry.count({ where: { resourceType: 'fleet-approval', resourceId: approvalId, key: 'fleet.approval.decide.assistant' } })).toBe(0);
  });
});
