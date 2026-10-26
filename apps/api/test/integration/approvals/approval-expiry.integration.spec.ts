/**
 * P3 approval core US-012 — the expiry sweeper against the real database.
 *
 * A case opens its pending requests the way production does: `ApprovalGate.gate` as AGENT/a1, which
 * holds `label.delete` in the project. `tick(now)` then runs past the rows' `expiresAt` and the test
 * reads the stored row, the audit entry and (for `onTimeout: 'approve'`) the registered command.
 *
 * Run: cd apps/api && bun run test:db:up && KODA_DB_TESTS=1 bunx vitest run test/integration/approvals/approval-expiry.integration.spec.ts
 */
import { Logger } from '@nestjs/common';
import type { NathApplication } from '@nathapp/nestjs-app';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { AuditRecorder } from '../../../src/audit/audit-recorder.service';
import { ApprovalCommandRegistry } from '../../../src/approvals/approval-command.registry';
import { ApprovalGate } from '../../../src/approvals/approval-gate.service';
import { ApprovalPolicyService } from '../../../src/approvals/approval-policy.service';
import { ApprovalRequestExpirySweeper } from '../../../src/approvals/approval-request-expiry.sweeper';
import type { ApprovalRequestRecord } from '../../../src/approvals/domain/approval.domain';
import { PrismaApprovalRequestRepository } from '../../../src/approvals/prisma-approval-request.repository';
import { grantKeys } from '../../../src/approvals/test-helpers/approval-fixtures';
import {
  configurableTestCommand,
  type ConfigurableTestCommand,
  type TestCommandAudit,
  type TestCommandPrisma,
} from '../../../src/approvals/test-helpers/test-approval-command';
import type { Prisma } from '../../../src/generated/prisma/client';
import { PermissionCache } from '../../../src/permissions/permission-cache';
import { fixtureDb, withTestActor } from '../../helpers/action-context';
import { bootHttpApp } from '../../helpers/http-app';
import { resetDb } from '../../helpers/reset-db';
import { canRunDbTests } from '../../helpers/test-environment';

vi.setConfig({ testTimeout: 60_000 });

const NOW = new Date('2026-11-06T09:00:00Z');
const secondsAfter = (base: Date, seconds: number): Date => new Date(base.getTime() + seconds * 1_000);
const agent = { type: 'AGENT', id: 'a1' } as const;
const user = { type: 'USER', id: 'u1' } as const;

(canRunDbTests() ? describe : describe.skip)('Approval request expiry sweep through AppModule', () => {
  let app: NathApplication;
  let db: ReturnType<typeof fixtureDb>;
  let gate: ApprovalGate;
  let policies: ApprovalPolicyService;
  let sweeper: ApprovalRequestExpirySweeper;
  let requests: PrismaApprovalRequestRepository;
  let labels: ConfigurableTestCommand;

  /** Opens the pending `label.delete` request a case will let run out of time. */
  const open = async (labelId = 'l1'): Promise<ApprovalRequestRecord> => {
    const outcome = await withTestActor(agent, () => gate.gate('label.delete', { labelId }, { projectId: 'p1' }, NOW));
    if (outcome.status !== 'pending') throw new Error(`expected a pending outcome, got ${outcome.status}`);
    return outcome.request;
  };
  const stored = (id: string) => db.approvalRequest.findUniqueOrThrow({ where: { id } });
  const auditRows = (id: string) => db.auditEntry.findMany({ where: { key: 'system.approval.expire', resourceId: id }, take: 10 });
  /** A project policy that approves on timeout, which is only legal above a `none` floor. */
  const approveOnTimeout = () => withTestActor(user, () => policies.create({
    projectId: 'p1', permissionPattern: 'label.delete', appliesTo: { kind: 'all' },
    mode: 'agent', timeoutSec: 600, onTimeout: 'approve',
  }));
  /** `count` pending rows already past their expiry, with no gate call in the way of the batch cap. */
  const createDue = (count: number): Promise<{ count: number }> => db.approvalRequest.createMany({
    data: Array.from({ length: count }, (_, index): Prisma.ApprovalRequestCreateManyInput => ({
      id: `due-${String(index).padStart(3, '0')}`,
      permissionKey: 'label.delete',
      projectId: 'p1',
      actorType: 'AGENT',
      actorId: 'a1',
      origin: 'rest',
      correlationId: 'c1',
      input: { labelId: `l${index}` },
      inputHash: `hash-${index}`,
      requiredMode: 'agent',
      onTimeout: 'reject',
      approverMustHoldAction: true,
      requireDistinctApprover: false,
      status: 'pending',
      expiresAt: new Date(NOW.getTime() - 1_000),
    })),
  });

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    db = fixtureDb(app);
    await db.project.create({ data: { id: 'p1', slug: 'expiry-p1', key: 'EXPY', name: 'Expiry project' } });
    gate = app.get(ApprovalGate, { strict: false });
    policies = app.get(ApprovalPolicyService, { strict: false });
    sweeper = app.get(ApprovalRequestExpirySweeper, { strict: false });
    requests = app.get(PrismaApprovalRequestRepository, { strict: false });
    labels = configurableTestCommand('label.delete', {
      prisma: app.get(PrismaService, { strict: false }) as unknown as TestCommandPrisma,
      audit: app.get(AuditRecorder, { strict: false }) as unknown as TestCommandAudit,
    });
    app.get(ApprovalCommandRegistry, { strict: false }).register(labels.command);
  });
  afterAll(async () => { await app?.close(); });
  beforeEach(async () => {
    labels.reset();
    await db.approvalRequest.deleteMany();
    await db.approvalPolicy.deleteMany();
    await db.auditEntry.deleteMany();
    await db.roleBinding.deleteMany({ where: { principalType: 'AGENT', principalId: 'a1' } });
    await grantKeys(db, agent, ['label.delete'], 'p1');
    await app.get(PermissionCache, { strict: false }).invalidate();
  });

  it('AC-1: a reject-on-timeout request expires with settledAt at now', async () => {
    const opened = await open();
    expect(opened).toMatchObject({ status: 'pending', onTimeout: 'reject' });
    const later = secondsAfter(opened.expiresAt, 60);

    expect(await sweeper.tick(later)).toEqual({ expired: 1, approved: 0, failed: 0 });

    const row = await stored(opened.id);
    expect(row.status).toBe('expired');
    expect(row.settledAt?.getTime()).toBe(later.getTime());
  });

  it('AC-2: that expiry leaves one system.approval.expire entry as SYSTEM/approval', async () => {
    const opened = await open();

    await sweeper.tick(secondsAfter(opened.expiresAt, 60));

    expect(await auditRows(opened.id)).toEqual([
      expect.objectContaining({
        key: 'system.approval.expire',
        actorType: 'SYSTEM',
        actorId: 'approval',
        resourceType: 'approval-request',
        resourceId: opened.id,
        summary: 'expired label.delete',
      }),
    ]);
  });

  it('AC-3: an approve-on-timeout request is approved, executed once and satisfied by none', async () => {
    const policy = await approveOnTimeout();
    const opened = await open();
    expect(opened).toMatchObject({ status: 'pending', onTimeout: 'approve', policyId: policy.id });

    expect(await sweeper.tick(secondsAfter(opened.expiresAt, 1))).toEqual({ expired: 0, approved: 1, failed: 0 });

    expect(labels.state.calls).toEqual([{ labelId: 'l1' }]);
    const row = await stored(opened.id);
    expect(row.status).toBe('executed');
    expect(row.satisfiedBy).toBe('none');
    expect(row.approverType).toBeNull();
    expect(row.approverId).toBeNull();
    expect(await db.approvalDecision.count({ where: { requestId: opened.id } })).toBe(0);
  });

  it('AC-4: that timeout approval leaves an approved-on-timeout system entry', async () => {
    await approveOnTimeout();
    const opened = await open();

    await sweeper.tick(secondsAfter(opened.expiresAt, 1));

    expect(await auditRows(opened.id)).toEqual([
      expect.objectContaining({
        key: 'system.approval.expire',
        actorType: 'SYSTEM',
        actorId: 'approval',
        summary: 'approved on timeout label.delete',
      }),
    ]);
  });

  it('AC-5: a tick before every expiry changes no row', async () => {
    const opened = await open();
    const before = await stored(opened.id);

    expect(await sweeper.tick(new Date(NOW.getTime() + 1_000))).toEqual({ expired: 0, approved: 0, failed: 0 });

    expect(await stored(opened.id)).toEqual(before);
    expect(await auditRows(opened.id)).toEqual([]);
    expect(labels.state.calls).toEqual([]);
  });

  it('AC-6: a request already rejected is untouched even past its expiry', async () => {
    const opened = await open();
    await db.approvalRequest.update({ where: { id: opened.id }, data: { status: 'rejected', decidedAt: NOW } });
    const before = await stored(opened.id);

    expect(await sweeper.tick(secondsAfter(opened.expiresAt, 60))).toEqual({ expired: 0, approved: 0, failed: 0 });

    expect(await stored(opened.id)).toEqual(before);
    expect(await auditRows(opened.id)).toEqual([]);
  });

  it('AC-7: one throwing lock is counted and logged at warn, and the next request still expires', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn');
    warn.mockClear();
    const first = await open('l1');
    const second = await open('l2');
    const lock = requests.lockById.bind(requests);
    const spy = vi.spyOn(requests, 'lockById').mockImplementation(async (id: string) => {
      if (id === first.id) throw new Error('lock refused');
      return lock(id);
    });

    let result: Awaited<ReturnType<ApprovalRequestExpirySweeper['tick']>> | undefined;
    try {
      result = await sweeper.tick(secondsAfter(second.expiresAt, 60));
    } finally {
      spy.mockRestore();
    }

    expect(result).toEqual({ expired: 1, approved: 0, failed: 1 });
    expect(warn.mock.calls.map(([message]) => String(message))).toEqual([
      `Approval request ${first.id} not settled: lock refused`,
    ]);
    expect((await stored(first.id)).status).toBe('pending');
    expect((await stored(second.id)).status).toBe('expired');
  });

  it('AC-8: 101 due requests settle exactly 100 in one tick', async () => {
    await createDue(101);

    expect(await sweeper.tick(NOW)).toEqual({ expired: 100, approved: 0, failed: 0 });

    expect(await db.approvalRequest.count({ where: { status: 'expired' } })).toBe(100);
    expect(await db.approvalRequest.count({ where: { status: 'pending' } })).toBe(1);
  });
});
