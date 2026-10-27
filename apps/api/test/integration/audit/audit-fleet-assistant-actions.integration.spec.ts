import { findThreadAction } from '../../helpers/assistant-request';
import { grantKeys } from '../../../src/approvals/test-helpers/approval-fixtures';
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
const APPROVALS = '/api/approvals';
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
    const row = await findThreadAction(prisma, { jobId: heldJobId, toolCallId });
    return { actionId: row.id, approvalId: row.id };
  }

  const decide = (approvalId: string, token: string, decision: 'approve' | 'reject') =>
    request(server()).post(`${APPROVALS}/${approvalId}/decisions`).set({ Authorization: `Bearer ${token}` }).send({ decision });

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
    await grantKeys(prisma, { type: 'USER', id: world.ids.dev }, ['approval.decide'], world.projectId);
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

  it('request opening is bookkeeping, not an audited mutation', async () => {
    const before = await prisma.auditEntry.count();
    const { actionId } = await propose(`audit-open-${++seq}`);
    expect(await prisma.auditEntry.count()).toBe(before);
    expect(await prisma.approvalRequest.findUniqueOrThrow({ where: { id: actionId } })).toMatchObject({ status: 'pending' });
    expect(await prisma.assistantActionRequest.count({ where: { requestId: actionId } })).toBe(1);
  });

  it('an approved dispatch inherits the request approval context', async () => {
    const feature = `audit-dispatch-${++seq}`;
    const { actionId, approvalId } = await propose(feature);
    await decide(approvalId, world.tokens.dev, 'approve').expect(200);
    const dispatch = await prisma.fleetJob.findFirstOrThrow({ where: { projectId: world.projectId, feature } });
    const writes = await prisma.auditEntry.findMany({ where: { resourceType: 'fleet-job', resourceId: dispatch.id, key: 'fleet.job.dispatch' } });
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ actorType: 'SYSTEM', actorId: 'assistant', onBehalfOfType: 'USER', onBehalfOfId: world.ids.dev, origin: 'thread', satisfiedBy: 'human', approverType: 'USER', approverId: world.ids.dev, approvalRequestId: actionId });
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

});
