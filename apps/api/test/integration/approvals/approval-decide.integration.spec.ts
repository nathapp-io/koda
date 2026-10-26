import type { NathApplication } from '@nathapp/nestjs-app';
import { ApprovalDecisionService } from '../../../src/approvals/approval-decision.service';
import { ApprovalGate } from '../../../src/approvals/approval-gate.service';
import { ApprovalCommandRegistry } from '../../../src/approvals/approval-command.registry';
import { ApprovalDecideForbiddenError, ApprovalRequestExpiredError, ApprovalRequestNotFoundError, ApprovalRequestNotPendingError } from '../../../src/approvals/domain/approval.errors';
import { grantKeys } from '../../../src/approvals/test-helpers/approval-fixtures';
import { configurableTestCommand } from '../../../src/approvals/test-helpers/test-approval-command';
import { grantRole } from '../../../src/permissions/test-helpers/permission-fixtures';
import { PermissionCache } from '../../../src/permissions/permission-cache';
import { AuditRecorder } from '../../../src/audit/audit-recorder.service';
import { fixtureDb, withTestActor } from '../../helpers/action-context';
import { bootHttpApp } from '../../helpers/http-app';
import { resetDb } from '../../helpers/reset-db';
import { canRunDbTests } from '../../helpers/test-environment';

(canRunDbTests() ? describe : describe.skip)('Approval decisions through AppModule', () => {
  let app: NathApplication;
  let db: ReturnType<typeof fixtureDb>;
  let service: ApprovalDecisionService;
  let gate: ApprovalGate;
  const labels = configurableTestCommand('label.delete');
  const roles = configurableTestCommand('role.manage');
  const now = new Date('2026-11-05T09:00:00Z');
  const actor = { type: 'AGENT', id: 'a1' } as const;
  const user = { type: 'USER', id: 'u1' } as const;
  const open = async (global = false) => {
    const outcome = await withTestActor(actor, () => gate.gate(global ? 'role.manage' : 'label.delete',
      global ? { roleId: 'r1' } : { labelId: 'l1' }, { projectId: global ? null : 'p1' }, now));
    if (outcome.status !== 'pending') throw new Error('expected pending request');
    return outcome.request;
  };
  const decide = (id: string, decision: 'approve' | 'reject' = 'approve', at = now) =>
    withTestActor(user, () => service.decide(id, decision, decision === 'reject' ? 'no' : null, at));
  beforeAll(async () => {
    await resetDb(); app = await bootHttpApp({ registrationEnabled: false }); db = fixtureDb(app);
    for (const id of ['p1', 'p2']) await db.project.create({ data: { id, slug: `decide-${id}`, key: `DEC${id}`, name: id } });
    gate = app.get(ApprovalGate, { strict: false }); service = app.get(ApprovalDecisionService, { strict: false });
    const registry = app.get(ApprovalCommandRegistry, { strict: false });
    registry.register(labels.command); registry.register(roles.command);
  });
  afterAll(async () => { await app?.close(); });
  beforeEach(async () => {
    labels.reset(); roles.reset();
    await db.approvalRequest.deleteMany(); await db.approvalPolicy.deleteMany();
    await db.roleBinding.deleteMany({ where: { principalId: { in: ['a1', 'u1', 'u2'] } } });
    await grantKeys(db, actor, ['label.delete'], 'p1');
    // Fixtures bypass membership services, so invalidate their cached effective keys explicitly.
    await app.get(PermissionCache, { strict: false }).invalidate();
  });
  const eligible = () => grantRole(db, user, 'project-admin', 'p1');

  it('AC-1, AC-2, AC-3: rejects without running and persists the decision and audit metadata', async () => {
    await eligible(); const r = await open();
    expect(await decide(r.id, 'reject')).toMatchObject({ status: 'rejected' });
    expect(labels.state.calls).toEqual([]);
    expect(await db.approvalDecision.findMany({ where: { requestId: r.id }, take: 10 })).toEqual([
      expect.objectContaining({ deciderType: 'USER', deciderId: 'u1', decision: 'reject', comment: 'no' }),
    ]);
    const entries = await db.auditEntry.findMany({ where: { key: 'approval.decide', resourceId: r.id }, take: 10 });
    expect(entries).toEqual([expect.objectContaining({ resourceType: 'approval-request', summary: 'rejected label.delete', satisfiedBy: 'none', approvalRequestId: r.id, approverType: null, approverId: null })]);
  });
  it('AC-4: audits the human approval of an agent-mode request', async () => {
    await eligible(); const r = await open(); await decide(r.id);
    expect(await db.auditEntry.findMany({ where: { key: 'approval.decide', resourceId: r.id }, take: 10 })).toEqual([
      expect.objectContaining({ requiredMode: 'agent', satisfiedBy: 'human', approverType: 'USER', approverId: 'u1' }),
    ]);
  });
  it.each([5, 6, 7])('AC-%i: refuses an ineligible principal without writes', async (ac) => {
    const r = await open();
    if (ac !== 5) await grantKeys(db, user, ['label.delete'], 'p1');
    if (ac === 7) await grantRole(db, user, 'project-admin', 'p2');
    const attempt = ac === 5 ? withTestActor(actor, () => service.decide(r.id, 'approve', null, now)) : decide(r.id);
    await expect(attempt).rejects.toEqual(new ApprovalDecideForbiddenError(ac === 5 ? 'tier-too-low' : 'missing-decide-permission'));
    expect(await db.approvalDecision.count({ where: { requestId: r.id } })).toBe(0);
    expect((await db.approvalRequest.findUniqueOrThrow({ where: { id: r.id } })).status).toBe('pending');
    expect(await db.auditEntry.count({ where: { key: 'approval.decide', resourceId: r.id } })).toBe(0);
  });
  it('AC-8: refuses a second decision', async () => {
    await eligible(); const r = await open(); await decide(r.id, 'reject');
    await expect(decide(r.id)).rejects.toEqual(new ApprovalRequestNotPendingError('rejected'));
    expect(await db.approvalDecision.count({ where: { requestId: r.id } })).toBe(1);
  });
  it('AC-9: leaves expired requests pending for the sweeper', async () => {
    await eligible(); const r = await open();
    await expect(decide(r.id, 'approve', new Date(r.expiresAt.getTime() + 1))).rejects.toEqual(new ApprovalRequestExpiredError(r.id));
    expect((await db.approvalRequest.findUniqueOrThrow({ where: { id: r.id } })).status).toBe('pending');
    expect(await db.approvalDecision.count({ where: { requestId: r.id } })).toBe(0);
  });
  it('AC-10: refuses a missing request', async () => {
    await expect(decide('missing')).rejects.toEqual(new ApprovalRequestNotFoundError('missing'));
  });
  it('AC-11: serializes concurrent approvals by different users', async () => {
    await eligible(); await grantRole(db, { type: 'USER', id: 'u2' }, 'project-admin', 'p1');
    const r = await open();
    const results = await Promise.allSettled([decide(r.id), withTestActor({ type: 'USER', id: 'u2' }, () => service.decide(r.id, 'approve', null, now))]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const failures = results.filter((result) => result.status === 'rejected');
    expect(failures).toHaveLength(1);
    expect(failures[0].reason).toBeInstanceOf(ApprovalRequestNotPendingError);
    expect(await db.approvalDecision.count({ where: { requestId: r.id } })).toBe(1);
  });
  it('AC-12: accepts global admin for a global request', async () => {
    await grantKeys(db, actor, ['role.manage'], null); await grantRole(db, user, 'admin', null);
    const r = await open(true); await expect(decide(r.id)).resolves.toBeDefined();
    expect(await db.approvalDecision.findMany({ where: { requestId: r.id }, take: 10 })).toEqual([
      expect.objectContaining({ deciderType: 'USER', deciderId: 'u1' }),
    ]);
  });
  it('rolls back the decision and request transition if audit storage fails', async () => {
    await eligible(); const r = await open();
    const audit = app.get(AuditRecorder, { strict: false });
    const failure = new Error('audit unavailable');
    const spy = vi.spyOn(audit, 'record').mockRejectedValueOnce(failure);
    try {
      await expect(decide(r.id)).rejects.toBe(failure);
    } finally { spy.mockRestore(); }
    expect((await db.approvalRequest.findUniqueOrThrow({ where: { id: r.id } })).status).toBe('pending');
    expect(await db.approvalDecision.count({ where: { requestId: r.id } })).toBe(0);
    expect(await db.auditEntry.count({ where: { key: 'approval.decide', resourceId: r.id } })).toBe(0);
  });
  it('AC-13: a project binding cannot approve a global action', async () => {
    await grantKeys(db, actor, ['role.manage'], null); await eligible(); const r = await open(true);
    await expect(decide(r.id)).rejects.toEqual(new ApprovalDecideForbiddenError('missing-action-permission'));
    expect(await db.approvalDecision.count({ where: { requestId: r.id } })).toBe(0);
  });
});
