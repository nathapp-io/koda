import { canRunDbTests } from '../../helpers/test-environment';
import request from 'supertest';
import { NathApplication } from '@nathapp/nestjs-app';
import { Prisma, PrismaClient } from '../../../src/generated/prisma/client';
import type { ApprovalRequestEventPayload, SyncRequest } from '@nathapp/fleet-protocol';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp } from '../../helpers/http-app';
import { enrollRunner, seedFleetHttpWorld, syncBody } from '../../helpers/fleet-fixtures';
import { fixtureDb } from '../../helpers/action-context';
import { ApprovalRequestExpirySweeper } from '../../../src/approvals/approval-request-expiry.sweeper';
import { AuditRecorder } from '../../../src/audit/audit-recorder.service';

/**
 * Permissions P3 US-006: the bash ask is an `ApprovalRequest` with a `FleetApprovalAsk` link, so this spec reads those
 * two tables, expires through the engine's `ApprovalRequestExpirySweeper`, and closes through the job transition.
 */
const describeIntegration = canRunDbTests() ? describe : describe.skip;
vi.setConfig({ testTimeout: 30_000 });

const ask = (id: string): ApprovalRequestEventPayload => ({ naxAskId: id, deadlineAt: new Date(Date.now() + 300_000).toISOString(), command: 'true', commandTruncated: false, maskedCount: 0, root: '/repo', stage: 'execution', storyId: 'US-005', featureName: 'audit', reason: 'rule', options: ['allow', 'deny'] });

describeIntegration('fleet system approval audit (PG)', () => {
  let app: NathApplication;
  let server: ReturnType<NathApplication['getHttpServer']>;
  let prisma: PrismaClient;
  let world: Awaited<ReturnType<typeof seedFleetHttpWorld>>;
  let runner: { runnerId: string; apiKey: string };
  let n = 0;
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
  const sync = (body: Partial<SyncRequest> = {}) => request(server).post('/api/fleet/runner/sync').set(auth(runner.apiKey)).send(syncBody({ protocolVersion: 2, ...body })).expect(200);
  const createJob = (state: 'RUNNING' | 'COMPLETED' = 'RUNNING') => prisma.fleetJob.create({ data: {
    projectId: world.projectId, repoId: world.repoId, ref: 'main', command: 'RUN', feature: `audit-system-${++n}`, profiles: [], maxCostUsd: new Prisma.Decimal(5), selectorLabels: [], requestedById: world.ids.dev, state, runnerId: runner.runnerId, leaseEpoch: 1, bashMode: 'escalate', approvalTimeoutSec: 600, firstStartedAt: new Date(),
  } });
  /** A RUNNING job whose ask was relayed: the engine request and its link. */
  const openAsk = async (bashMode: 'escalate' | 'raw' = 'escalate') => {
    const job = await createJob();
    await prisma.fleetJob.update({ where: { id: job.id }, data: { bashMode } });
    await sync({ jobs: [{ jobId: job.id, leaseEpoch: 1, events: [{ seq: 1, type: 'approval_request', payload: ask(`ask-${++n}`) }] }] });
    const link = await prisma.fleetApprovalAsk.findFirst({ where: { jobId: job.id } });
    return { job, requestId: link?.requestId ?? null };
  };
  const auditRows = (resourceId: string, key?: string) => prisma.auditEntry.findMany({ where: { resourceId, ...(key ? { key } : {}) } });
  const requestOf = (id: string) => prisma.approvalRequest.findUniqueOrThrow({ where: { id } });
  const decide = (id: string) => request(server).post(`/api/approvals/${id}/decisions`).set(auth(world.tokens.root)).send({ decision: 'approve' });
  const sweeper = () => app.get(ApprovalRequestExpirySweeper, { strict: false });

  beforeAll(async () => {
    const previous = process.env.FLEET_SYNC_WAIT_MS;
    process.env.FLEET_SYNC_WAIT_MS = '100';
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    server = app.getHttpServer();
    prisma = fixtureDb(app);
    world = await seedFleetHttpWorld(server, prisma);
    runner = await enrollRunner(server, world.tokens.root, 'approval-audit-runner');
    if (previous === undefined) delete process.env.FLEET_SYNC_WAIT_MS;
    else process.env.FLEET_SYNC_WAIT_MS = previous;
  });
  afterAll(async () => { await app.close(); });
  beforeEach(async () => {
    await prisma.auditEntry.deleteMany();
    await prisma.fleetApprovalAsk.deleteMany();
    await prisma.approvalDecision.deleteMany();
    await prisma.approvalRequest.deleteMany();
    await prisma.fleetCommand.deleteMany();
    await prisma.fleetJob.deleteMany();
  });

  it('AC-1/3: a runner ask writes one RUNNER entry; replay does not duplicate it', async () => {
    const job = await createJob();
    const event = { seq: 1, type: 'approval_request' as const, payload: ask(`ask-${++n}`) };
    await sync({ jobs: [{ jobId: job.id, leaseEpoch: 1, events: [event] }] });
    const link = await prisma.fleetApprovalAsk.findFirstOrThrow({ where: { jobId: job.id } });
    expect(await auditRows(link.requestId, 'runner.sync')).toMatchObject([{ key: 'runner.sync', resourceType: 'fleet-approval', resourceId: link.requestId, projectId: world.projectId, actorType: 'RUNNER', actorId: runner.runnerId, summary: 'bash ask opened, pending' }]);
    await sync({ jobs: [{ jobId: job.id, leaseEpoch: 1, events: [event] }] });
    expect(await auditRows(link.requestId, 'runner.sync')).toHaveLength(1);
  });

  it('AC-2: a raw-mode runner ask opens nothing and records the reason on the job', async () => {
    const { job, requestId } = await openAsk('raw');
    expect(requestId).toBeNull();
    expect(await auditRows(job.id, 'runner.sync')).toMatchObject([{ summary: 'bash ask not opened: raw mode', resourceType: 'fleet-job', actorType: 'RUNNER', actorId: runner.runnerId }]);
  });

  it('AC-6: the engine sweeper expires a past-due ask once, and a decide after it is 409 with no decide entry', async () => {
    const { requestId } = await openAsk();
    await prisma.approvalRequest.update({ where: { id: requestId as string }, data: { expiresAt: new Date(Date.now() - 1_000) } });

    expect(await sweeper().tick(new Date())).toMatchObject({ expired: 1, failed: 0 });
    expect(await auditRows(requestId as string, 'system.approval.expire')).toMatchObject([{ actorType: 'SYSTEM', actorId: 'approval', origin: 'system', summary: 'expired fleet.job.shell.escalate', resourceType: 'approval-request' }]);

    await decide(requestId as string).expect(409);
    expect(await auditRows(requestId as string, 'approval.decide')).toHaveLength(0);
    expect((await requestOf(requestId as string)).status).toBe('expired');
  });

  it('AC-7/13: the job-end close cancels the ask, and a decide after it is 409 with no decide entry', async () => {
    const { job, requestId } = await openAsk();

    await sync({ jobs: [{ jobId: job.id, leaseEpoch: 1, events: [{ seq: 2, type: 'state', payload: { to: 'UPLOADING' } }] }] });

    expect(await requestOf(requestId as string)).toMatchObject({ status: 'cancelled', result: { closedBy: 'job_ended' } });
    // The job-end close is the fleet's, not the engine sweeper's: it records no system expiry entry.
    expect(await auditRows(requestId as string, 'system.approval.expire')).toHaveLength(0);
    await decide(requestId as string).expect(409);
    expect(await auditRows(requestId as string, 'approval.decide')).toHaveLength(0);
  });

  it('AC-8: a RUNNING-to-UPLOADING transition closes pending asks without system expiry entries', async () => {
    const { job, requestId } = await openAsk();
    await sync({ jobs: [{ jobId: job.id, leaseEpoch: 1, events: [{ seq: 2, type: 'state', payload: { to: 'UPLOADING' } }] }] });
    expect(await requestOf(requestId as string)).toMatchObject({ status: 'cancelled' });
    expect(await auditRows(requestId as string, 'system.approval.expire')).toHaveLength(0);
  });

  it('AC-11/12: audit failure rolls back the sweeper expiry and the decide', async () => {
    const { requestId: swept } = await openAsk();
    const audit = app.get(AuditRecorder);
    const record = vi.spyOn(audit, 'record').mockRejectedValue(new Error('audit refused'));
    await prisma.approvalRequest.update({ where: { id: swept as string }, data: { expiresAt: new Date(Date.now() - 1_000) } });
    expect(await sweeper().tick(new Date())).toMatchObject({ expired: 0, failed: 1 });
    expect((await requestOf(swept as string)).status).toBe('pending');
    record.mockRestore();

    const { requestId: decided } = await openAsk();
    const decideRecord = vi.spyOn(audit, 'record').mockRejectedValue(new Error('audit refused'));
    const response = await decide(decided as string);
    expect(response.status).not.toBe(409);
    expect((await requestOf(decided as string)).status).toBe('pending');
    decideRecord.mockRestore();
  });

  it('AC-4/5: the engine sweeper audits once and repeated ticks are idempotent', async () => {
    const { requestId } = await openAsk();
    await prisma.approvalRequest.update({ where: { id: requestId as string }, data: { expiresAt: new Date(Date.now() - 1_000) } });
    expect(await sweeper().tick(new Date())).toMatchObject({ expired: 1, failed: 0 });
    expect(await auditRows(requestId as string, 'system.approval.expire')).toMatchObject([{ actorType: 'SYSTEM', actorId: 'approval', origin: 'system', summary: 'expired fleet.job.shell.escalate' }]);
    await sweeper().tick(new Date());
    expect(await auditRows(requestId as string, 'system.approval.expire')).toHaveLength(1);
  });
});
