import { canRunDbTests } from '../../helpers/test-environment';
import request from 'supertest';
import { NathApplication } from '@nathapp/nestjs-app';
import { Prisma, PrismaClient } from '../../../src/generated/prisma/client';
import type { ApprovalRequestEventPayload, SyncRequest } from '@nathapp/fleet-protocol';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp } from '../../helpers/http-app';
import { enrollRunner, seedFleetHttpWorld, syncBody } from '../../helpers/fleet-fixtures';
import { fixtureDb } from '../../helpers/action-context';
import { ApprovalExpirySweeper } from '../../../src/fleet/approvals/approval-expiry-sweeper';
import { AuditRecorder } from '../../../src/audit/audit-recorder.service';

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
  const openAsk = async (bashMode: 'escalate' | 'raw' = 'escalate') => {
    const job = await createJob();
    await prisma.fleetJob.update({ where: { id: job.id }, data: { bashMode } });
    await sync({ jobs: [{ jobId: job.id, leaseEpoch: 1, events: [{ seq: 1, type: 'approval_request', payload: ask(`ask-${++n}`) }] }] });
    return { job, approval: await prisma.fleetApproval.findFirstOrThrow({ where: { jobId: job.id } }) };
  };
  const auditRows = (id: string, key?: string) => prisma.auditEntry.findMany({ where: { resourceId: id, ...(key ? { key } : {}) } });

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
    await prisma.fleetApproval.deleteMany();
    await prisma.fleetCommand.deleteMany();
    await prisma.fleetJob.deleteMany();
  });

  it('AC-1/3: a runner ask writes one RUNNER entry; replay does not duplicate it', async () => {
    const job = await createJob();
    const event = { seq: 1, type: 'approval_request' as const, payload: ask(`ask-${++n}`) };
    await sync({ jobs: [{ jobId: job.id, leaseEpoch: 1, events: [event] }] });
    const approval = await prisma.fleetApproval.findFirstOrThrow({ where: { jobId: job.id } });
    expect(await auditRows(approval.id, 'runner.sync')).toMatchObject([{ key: 'runner.sync', resourceType: 'fleet-approval', resourceId: approval.id, projectId: world.projectId, actorType: 'RUNNER', actorId: runner.runnerId, summary: 'bash ask opened, pending' }]);
    await sync({ jobs: [{ jobId: job.id, leaseEpoch: 1, events: [event] }] });
    expect(await auditRows(approval.id, 'runner.sync')).toHaveLength(1);
  });

  it('AC-2: raw-mode runner asks persist a cancelled summary', async () => {
    const { approval } = await openAsk('raw');
    expect(await auditRows(approval.id, 'runner.sync')).toMatchObject([{ summary: 'bash ask opened, cancelled', actorType: 'RUNNER', actorId: runner.runnerId }]);
  });

  it('AC-6/7/13: real HTTP decide commits expiry and job-end close before 409, and valid decide has no expiry entry', async () => {
    const { approval: expired } = await openAsk();
    await prisma.fleetApproval.update({ where: { id: expired.id }, data: { expiresAt: new Date(Date.now() - 1_000) } });
    await request(server).post(`/api/fleet/approvals/${expired.id}/decide`).set(auth(world.tokens.root)).send({ decision: 'allow' }).expect(409);
    expect(await auditRows(expired.id, 'system.approval.expire')).toMatchObject([{ actorType: 'SYSTEM', actorId: 'approval', origin: 'system', summary: 'expired', resourceType: 'fleet-approval' }]);
    expect(await auditRows(expired.id, 'fleet.approval.decide.bash')).toHaveLength(0);

    const { job, approval: ended } = await openAsk();
    await prisma.fleetJob.update({ where: { id: job.id }, data: { state: 'COMPLETED' } });
    await request(server).post(`/api/fleet/approvals/${ended.id}/decide`).set(auth(world.tokens.root)).send({ decision: 'allow' }).expect(409);
    expect(await auditRows(ended.id, 'system.approval.expire')).toMatchObject([{ summary: 'closed: job ended', actorType: 'SYSTEM', actorId: 'approval' }]);
    expect(await auditRows(ended.id, 'fleet.approval.decide.bash')).toHaveLength(0);

    const { approval: valid } = await openAsk();
    await request(server).post(`/api/fleet/approvals/${valid.id}/decide`).set(auth(world.tokens.root)).send({ decision: 'allow' }).expect(200);
    expect(await auditRows(valid.id, 'system.approval.expire')).toHaveLength(0);
  });

  it('AC-8: a RUNNING-to-UPLOADING transition closes pending asks without system expiry entries', async () => {
    const { job, approval } = await openAsk();
    await sync({ jobs: [{ jobId: job.id, leaseEpoch: 1, events: [{ seq: 2, type: 'state', payload: { to: 'UPLOADING' } }] }] });
    expect(await prisma.fleetApproval.findUniqueOrThrow({ where: { id: approval.id } })).toMatchObject({ status: 'cancelled' });
    expect(await auditRows(approval.id, 'system.approval.expire')).toHaveLength(0);
  });

  it('AC-11/12: audit failure rolls back expiry closes in sweeper and decide', async () => {
    const { approval } = await openAsk();
    const audit = app.get(AuditRecorder);
    const record = vi.spyOn(audit, 'record').mockRejectedValue(new Error('audit refused'));
    await prisma.fleetApproval.update({ where: { id: approval.id }, data: { expiresAt: new Date(Date.now() - 1_000) } });
    const swept = await app.get(ApprovalExpirySweeper).tick(new Date());
    expect(swept).toEqual({ expired: 0, failed: 1 });
    expect((await prisma.fleetApproval.findUniqueOrThrow({ where: { id: approval.id } })).status).toBe('pending');
    record.mockRestore();

    const { job, approval: ended } = await openAsk();
    const requestRecord = vi.spyOn(audit, 'record').mockRejectedValue(new Error('audit refused'));
    await prisma.fleetJob.update({ where: { id: job.id }, data: { state: 'COMPLETED' } });
    const response = await request(server).post(`/api/fleet/approvals/${ended.id}/decide`).set(auth(world.tokens.root)).send({ decision: 'allow' });
    expect(response.status).not.toBe(409);
    expect((await prisma.fleetApproval.findUniqueOrThrow({ where: { id: ended.id } })).status).toBe('pending');
    requestRecord.mockRestore();
  });

  it('AC-4/5: approval expiry sweeper audits once and repeated ticks are idempotent', async () => {
    const { approval } = await openAsk();
    await prisma.fleetApproval.update({ where: { id: approval.id }, data: { expiresAt: new Date(Date.now() - 1_000) } });
    const sweeper = app.get(ApprovalExpirySweeper);
    expect(await sweeper.tick(new Date())).toEqual({ expired: 1, failed: 0 });
    expect(await auditRows(approval.id, 'system.approval.expire')).toMatchObject([{ actorType: 'SYSTEM', actorId: 'approval', origin: 'system', summary: 'expired' }]);
    await sweeper.tick(new Date());
    expect(await auditRows(approval.id, 'system.approval.expire')).toHaveLength(1);
  });
});
