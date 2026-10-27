import { afterEach, vi } from 'vitest';
import { canRunDbTests } from '../../helpers/test-environment';
import type { NathApplication } from '@nathapp/nestjs-app';
import { Prisma, type PrismaClient } from '../../../src/generated/prisma/client';
import { ApprovalDecisionService } from '../../../src/approvals/approval-decision.service';
import { RunnerNotifier } from '../../../src/fleet/jobs/runner-notifier';
import { grantKeys } from '../../../src/approvals/test-helpers/approval-fixtures';
import { fixtureDb, withTestActor } from '../../helpers/action-context';
import { bootHttpApp } from '../../helpers/http-app';
import { resetDb } from '../../helpers/reset-db';
import { seedFleetAsk } from '../../helpers/fleet-ask-fixtures';

const integration = canRunDbTests() ? describe : describe.skip;
const now = new Date('2026-11-10T09:00:00Z');

integration('fleet shell escalation command through ApprovalDecisionService', () => {
  let app: NathApplication;
  let db: PrismaClient;
  let service: ApprovalDecisionService;
  let notifier: RunnerNotifier;
  let requestId: string;
  let jobId: string;
  let projectId: string;
  let runnerId: string;
  const userId = 'shell-approver';
  const naxAskId = 'nax-ask-1';

  const seedAsk = async () => (await seedFleetAsk(db, {
    kind: 'bash', projectId, expiresAt: new Date('2030-01-01T00:00:00Z'), input: { jobId, leaseEpoch: 3, naxAskId, payload: { options: ['allow', 'deny'] } },
    link: { jobId, leaseEpoch: 3, naxAskId },
  })).requestId;

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    db = fixtureDb(app);
    const user = await db.user.create({ data: { id: userId, email: `${userId}@koda.test`, passwordHash: 'x' } });
    const project = await db.project.create({ data: { name: 'Shell approvals', slug: 'shell-approvals', key: 'SHL' } });
    projectId = project.id;
    const repo = await db.fleetRepo.create({ data: {
      projectId, provider: 'github', owner: 'acme', name: 'shell', defaultBranch: 'main', createdById: user.id,
    } });
    const runner = await db.runner.create({ data: {
      name: 'shell-runner', apiKeyHash: 'shell-hash', os: 'linux', arch: 'x64', labels: [], capabilities: {},
      daemonVersion: '1.0.0', protocolVersion: 1, bootId: 'shell-boot', lastSeenAt: now, createdById: user.id,
    } });
    runnerId = runner.id;
    const job = await db.fleetJob.create({ data: {
      projectId, repoId: repo.id, ref: 'main', command: 'RUN', feature: 'shell-approval', profiles: [],
      maxCostUsd: new Prisma.Decimal(5), selectorLabels: [], requestedById: user.id, runnerId, state: 'RUNNING', leaseEpoch: 3,
    } });
    jobId = job.id;
    await grantKeys(db, { type: 'USER', id: userId }, ['fleet.job.shell.escalate', 'approval.decide@fleet.job.shell.escalate'], projectId);
    service = app.get(ApprovalDecisionService, { strict: false });
    notifier = app.get(RunnerNotifier, { strict: false });
  });

  afterAll(async () => { await app?.close(); });
  afterEach(() => { vi.restoreAllMocks(); });
  beforeEach(async () => {
    await db.fleetJob.update({ where: { id: jobId }, data: { state: 'RUNNING', leaseEpoch: 3, runnerId } });
    await db.fleetCommand.deleteMany({ where: { jobId } });
    await db.auditEntry.deleteMany({ where: { resourceId: { in: [requestId].filter((id): id is string => Boolean(id)) } } });
    await db.approvalRequest.deleteMany();
    requestId = await seedAsk();
  });

  it('AC-1: approving a completed job settles without writing an answer command', async () => {
    await db.fleetJob.update({ where: { id: jobId }, data: { state: 'COMPLETED' } });
    const settled = await withTestActor({ type: 'USER', id: userId }, () => service.decide(requestId, 'approve', null, now));

    expect(settled).toMatchObject({ status: 'executed', result: { answered: false } });
    expect(await db.fleetCommand.count({ where: { jobId, type: 'APPROVAL_ANSWER' } })).toBe(0);
    expect(await db.fleetApprovalAsk.findUnique({ where: { requestId } })).toMatchObject({ resolvedBy: 'job_ended' });
  });

  it('AC-2: approving an ask from an old lease settles without writing an answer command', async () => {
    await db.fleetJob.update({ where: { id: jobId }, data: { leaseEpoch: 4 } });
    const settled = await withTestActor({ type: 'USER', id: userId }, () => service.decide(requestId, 'approve', null, now));

    expect(settled).toMatchObject({ status: 'executed', result: { answered: false } });
    expect(await db.fleetCommand.count({ where: { jobId, type: 'APPROVAL_ANSWER' } })).toBe(0);
    expect(await db.fleetApprovalAsk.findUnique({ where: { requestId } })).toMatchObject({ resolvedBy: 'job_ended' });
  });

  it('AC-3: rejecting a completed job remains rejected and resolves the link', async () => {
    await db.fleetJob.update({ where: { id: jobId }, data: { state: 'COMPLETED' } });
    const settled = await withTestActor({ type: 'USER', id: userId }, () => service.decide(requestId, 'reject', null, now));

    expect(settled.status).toBe('rejected');
    expect(await db.fleetCommand.count({ where: { jobId, type: 'APPROVAL_ANSWER' } })).toBe(0);
    expect(await db.fleetApprovalAsk.findUnique({ where: { requestId } })).toMatchObject({ resolvedBy: 'job_ended' });
  });

  it('AC-4: a job without a runner resolves the ask without writing an answer command', async () => {
    await db.fleetJob.update({ where: { id: jobId }, data: { runnerId: null } });
    await withTestActor({ type: 'USER', id: userId }, () => service.decide(requestId, 'approve', null, now));

    expect(await db.fleetCommand.count({ where: { jobId, type: 'APPROVAL_ANSWER' } })).toBe(0);
    expect(await db.fleetApprovalAsk.findUnique({ where: { requestId } })).toMatchObject({ resolvedBy: 'job_ended' });
  });

  it('AC-10/11/12/14: approves, settles, writes the answer, wakes runner and audits', async () => {
    const notify = vi.spyOn(notifier, 'notify');
    const settled = await withTestActor({ type: 'USER', id: userId }, () => service.decide(requestId, 'approve', null, now));

    expect(await db.fleetCommand.findMany({ where: { jobId } })).toEqual([
      expect.objectContaining({ runnerId, leaseEpoch: 3, type: 'APPROVAL_ANSWER', payload: { approvalId: requestId, naxAskId, choice: 'allow' } }),
    ]);
    expect(settled).toMatchObject({ status: 'executed', result: { answered: true, choice: 'allow' } });
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith(runnerId);
    expect(await db.auditEntry.findFirst({ where: { key: 'fleet.job.shell.escalate', resourceId: requestId } })).toMatchObject({
      key: 'fleet.job.shell.escalate', summary: 'answered allow', approvalRequestId: requestId,
    });
    notify.mockRestore();
  });

  it('AC-13/15: rejects with a deny answer and audit entry', async () => {
    const notify = vi.spyOn(notifier, 'notify');
    const settled = await withTestActor({ type: 'USER', id: userId }, () => service.decide(requestId, 'reject', null, now));

    expect(await db.fleetCommand.findMany({ where: { jobId } })).toEqual([
      expect.objectContaining({ runnerId, leaseEpoch: 3, type: 'APPROVAL_ANSWER', payload: { approvalId: requestId, naxAskId, choice: 'deny' } }),
    ]);
    expect(settled.status).toBe('rejected');
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith(runnerId);
    expect(await db.auditEntry.findFirst({ where: { key: 'fleet.job.shell.escalate', resourceId: requestId } })).toMatchObject({
      key: 'fleet.job.shell.escalate', summary: 'answered deny', approvalRequestId: requestId,
    });
    notify.mockRestore();
  });

  it('AC-4: approving after the job is missing resolves the ask without writing an answer command', async () => {
    await db.fleetJob.delete({ where: { id: jobId } });
    const settled = await withTestActor({ type: 'USER', id: userId }, () => service.decide(requestId, 'approve', null, now));

    expect(settled).toMatchObject({ status: 'executed', result: { answered: false } });
    expect(await db.fleetCommand.count({ where: { jobId, type: 'APPROVAL_ANSWER' } })).toBe(0);
    expect(await db.fleetApprovalAsk.findUnique({ where: { requestId } })).toMatchObject({ resolvedBy: 'job_ended' });
  });
});
