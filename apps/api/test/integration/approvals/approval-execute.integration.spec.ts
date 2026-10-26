import type { NathApplication } from '@nathapp/nestjs-app';
import { TRANSACTION_MANAGER, type ITransactionManager } from '@nathapp/nestjs-data';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { currentContext, runWithActionContext, type ActionContext } from '../../../src/action-context/action-context';
import { UnauditedWriteError, runInAuditScope } from '../../../src/action-context/audit-coverage';
import { AuditRecorder } from '../../../src/audit/audit-recorder.service';
import { ApprovalCommandRegistry } from '../../../src/approvals/approval-command.registry';
import { ApprovalDecisionService } from '../../../src/approvals/approval-decision.service';
import { ApprovalExecutionService } from '../../../src/approvals/approval-execution.service';
import { ApprovalGate } from '../../../src/approvals/approval-gate.service';
import { ApprovalRequestEvents } from '../../../src/approvals/approval-request-events';
import { ApprovalRequestNotPendingError } from '../../../src/approvals/domain/approval.errors';
import { PrismaApprovalRequestRepository } from '../../../src/approvals/prisma-approval-request.repository';
import { grantKeys } from '../../../src/approvals/test-helpers/approval-fixtures';
import {
  configurableTestCommand,
  type ConfigurableTestCommand,
  type TestCommandAudit,
  type TestCommandPrisma,
} from '../../../src/approvals/test-helpers/test-approval-command';
import { PermissionCache } from '../../../src/permissions/permission-cache';
import { PermissionService } from '../../../src/permissions/permission.service';
import { grantRole, revokeProjectRoles } from '../../../src/permissions/test-helpers/permission-fixtures';
import { fixtureDb, withTestActor } from '../../helpers/action-context';
import { bootHttpApp } from '../../helpers/http-app';
import { resetDb } from '../../helpers/reset-db';
import { canRunDbTests } from '../../helpers/test-environment';

(canRunDbTests() ? describe : describe.skip)('Approval execution through AppModule', () => {
  let app: NathApplication;
  let db: ReturnType<typeof fixtureDb>;
  let gate: ApprovalGate;
  let decisions: ApprovalDecisionService;
  let executions: ApprovalExecutionService;
  let requests: PrismaApprovalRequestRepository;
  let labels: ConfigurableTestCommand;
  let roles: ConfigurableTestCommand;
  /** The action context every `label.delete` execution ran under, in call order. */
  const contexts: Array<ActionContext | undefined> = [];
  const now = new Date('2026-11-05T09:00:00Z');
  const agent = { type: 'AGENT', id: 'a1' } as const;
  const user = { type: 'USER', id: 'u1' } as const;

  const open = async (labelId = 'l1', global = false) => {
    const outcome = await withTestActor(agent, () => gate.gate(global ? 'role.manage' : 'label.delete',
      global ? { roleId: 'r1' } : { labelId }, { projectId: global ? null : 'p1' }, now));
    if (outcome.status !== 'pending') throw new Error('expected pending request');
    return outcome.request;
  };
  const decide = (id: string, who: { type: 'USER' | 'AGENT'; id: string } = user, decision: 'approve' | 'reject' = 'approve') =>
    withTestActor(who, () => decisions.decide(id, decision, null, now));
  /** Moves a pending request to approved through the repository, as a decide would. */
  const moveToApproved = (id: string) => withTestActor(user, () => requests.transition(id, 'pending', {
    status: 'approved', decidedAt: now, satisfiedBy: 'human', approverType: 'USER', approverId: 'u1',
  }));
  const stored = (id: string) => db.approvalRequest.findUniqueOrThrow({ where: { id } });
  const eligible = () => grantRole(db, user, 'project-admin', 'p1');

  beforeAll(async () => {
    await resetDb(); app = await bootHttpApp({ registrationEnabled: false }); db = fixtureDb(app);
    await db.project.create({ data: { id: 'p1', slug: 'execute-p1', key: 'EXE', name: 'Execution project' } });
    gate = app.get(ApprovalGate, { strict: false });
    decisions = app.get(ApprovalDecisionService, { strict: false });
    executions = app.get(ApprovalExecutionService, { strict: false });
    requests = app.get(PrismaApprovalRequestRepository, { strict: false });
    const deps = {
      prisma: app.get(PrismaService, { strict: false }) as unknown as TestCommandPrisma,
      audit: app.get(AuditRecorder, { strict: false }) as TestCommandAudit,
    };
    labels = configurableTestCommand('label.delete', deps);
    roles = configurableTestCommand('role.manage', deps);
    const run = labels.command.execute.bind(labels.command);
    labels.command.execute = async (input) => { contexts.push(currentContext()); return run(input); };
    const registry = app.get(ApprovalCommandRegistry, { strict: false });
    registry.register(labels.command); registry.register(roles.command);
  });
  afterAll(async () => { await app?.close(); });
  beforeEach(async () => {
    labels.reset(); roles.reset(); contexts.length = 0;
    await db.approvalRequest.deleteMany(); await db.approvalPolicy.deleteMany();
    await db.label.deleteMany(); await db.auditEntry.deleteMany({ where: { key: 'label.delete' } });
    await db.roleBinding.deleteMany({ where: { principalId: { in: ['a1', 'u1', 'u9'] } } });
    await grantKeys(db, agent, ['label.delete'], 'p1');
    await app.get(PermissionCache, { strict: false }).invalidate();
  });

  it('AC-1: approving runs the command once and returns the executed request', async () => {
    await eligible(); const r = await open();
    const settled = await decide(r.id);
    expect(labels.state.calls).toEqual([{ labelId: 'l1' }]);
    expect(settled.status).toBe('executed');
    expect(settled.settledAt).toBeInstanceOf(Date);
    expect((await stored(r.id)).status).toBe('executed');
  });

  it('records pending, approved and executed outbox events in transition order', async () => {
    await eligible(); await grantKeys(db, user, ['label.delete'], 'p1');
    const r = await open();
    await decide(r.id);
    const events = await db.outboxEvent.findMany({
      where: { type: 'approval_request_changed' }, orderBy: { createdAt: 'asc' }, take: 100,
    });
    const statuses = events.filter((event) => (event.payload as { requestId: string }).requestId === r.id)
      .map((event) => (event.payload as { status: string }).status);
    expect(statuses).toEqual(['pending', 'approved', 'executed']);
  });

  it('AC-2: the command runs under the request actor and the approval that released it', async () => {
    await eligible(); const r = await open(); await decide(r.id);
    expect(contexts).toHaveLength(1);
    expect(contexts[0]).toMatchObject({
      actor: { type: 'AGENT', id: 'a1' },
      approval: { requiredMode: 'agent', satisfiedBy: 'human', approverType: 'USER', approverId: 'u1', requestId: r.id },
    });
  });

  it('AC-3: an audit entry the command records carries the actor and the approval', async () => {
    await eligible(); labels.state.recordAudit = true; const r = await open(); await decide(r.id);
    expect(await db.auditEntry.findMany({ where: { key: 'label.delete' }, take: 10 })).toEqual([
      expect.objectContaining({ actorType: 'AGENT', actorId: 'a1', satisfiedBy: 'human', approvalRequestId: r.id }),
    ]);
  });

  it('AC-4: toResult becomes the stored result', async () => {
    await eligible(); labels.state.toResult = () => ({ deleted: 1 }); const r = await open();
    expect((await decide(r.id)).result).toEqual({ deleted: 1 });
    expect((await stored(r.id)).result).toEqual({ deleted: 1 });
  });

  it('AC-5: a throwing command rolls its write back and settles the request failed', async () => {
    await eligible(); labels.state.writeLabel = { projectId: 'p1', name: 'bug' }; labels.state.executeThrows = true;
    const r = await open();
    const settled = await decide(r.id);
    expect(settled).toMatchObject({ status: 'failed', result: { error: 'execution-failed', name: 'Error' } });
    expect(await db.label.count({ where: { projectId: 'p1', name: 'bug' } })).toBe(0);
    expect(await db.approvalDecision.count({ where: { requestId: r.id } })).toBe(1);
  });

  it('AC-6: a revoked binding fails the request without running the command', async () => {
    await eligible(); const r = await open();
    await revokeProjectRoles(db, agent, 'p1');
    expect(await decide(r.id)).toMatchObject({ status: 'failed', result: { error: 'permission-revoked' } });
    expect(labels.state.calls).toEqual([]);
  });

  it('AC-7: an altered frozen input fails the request without running the command', async () => {
    await eligible(); const r = await open();
    await db.approvalRequest.update({ where: { id: r.id }, data: { input: { labelId: 'l2' } } });
    expect(await decide(r.id)).toMatchObject({ status: 'failed', result: { error: 'input-hash-mismatch' } });
    expect(labels.state.calls).toEqual([]);
  });

  it('AC-8: no registered command fails the request with no-command', async () => {
    const r = await open(); await moveToApproved(r.id);
    const bare = new ApprovalExecutionService(app.get(TRANSACTION_MANAGER, { strict: false }) as ITransactionManager,
      requests, app.get(PermissionService, { strict: false }), new ApprovalCommandRegistry(),
      app.get(ApprovalRequestEvents, { strict: false }));
    expect(await bare.execute(r.id, now)).toMatchObject({ status: 'failed', result: { error: 'no-command' } });
    expect(labels.state.calls).toEqual([]);
  });

  it('AC-9: a frozen input that no longer parses fails the request with invalid-input', async () => {
    await eligible(); labels.state.parseThrowsAfter = 1; const r = await open();
    expect(await decide(r.id)).toMatchObject({ status: 'failed', result: { error: 'invalid-input' } });
    expect(labels.state.calls).toEqual([]);
  });

  it('AC-10: an assistant request runs after its on-behalf-of user approves and re-checks that user', async () => {
    await grantRole(db, { type: 'USER', id: 'u9' }, 'project-admin', 'p1');
    const outcome = await runWithActionContext(
      { actor: { type: 'SYSTEM', id: 'assistant' }, onBehalfOf: { type: 'USER', id: 'u9' }, origin: 'thread' },
      () => gate.gate('label.delete', { labelId: 'l1' }, { projectId: 'p1' }, now));
    if (outcome.status !== 'pending') throw new Error('expected pending request');
    const permissions = app.get(PermissionService, { strict: false });
    const spy = vi.spyOn(permissions, 'effectiveKeys');
    try {
      const settled = await decide(outcome.request.id, { type: 'USER', id: 'u9' });
      expect(settled.status).toBe('executed');
      expect(spy).toHaveBeenCalledWith({ type: 'USER', id: 'u9' }, { projectId: 'p1' });
      expect(spy).not.toHaveBeenCalledWith({ type: 'AGENT', id: 'a1' }, expect.anything());
    } finally { spy.mockRestore(); }
    expect(labels.state.calls).toEqual([{ labelId: 'l1' }]);
  });

  it('AC-11: executing a rejected request is refused', async () => {
    await eligible(); const r = await open(); await decide(r.id, user, 'reject');
    await expect(executions.execute(r.id, now)).rejects.toEqual(new ApprovalRequestNotPendingError('rejected'));
    expect(labels.state.calls).toEqual([]);
  });

  it('AC-12: executing an executed request is refused and does not run again', async () => {
    await eligible(); const r = await open(); await decide(r.id);
    await expect(executions.execute(r.id, now)).rejects.toEqual(new ApprovalRequestNotPendingError('executed'));
    expect(labels.state.calls).toHaveLength(1);
  });

  it('AC-13: execute inside an audit scope settles executed and failed without an unaudited write', async () => {
    const first = await open('l1'); const second = await open('l2');
    await moveToApproved(first.id); await moveToApproved(second.id);

    const ok = await runInAuditScope('test:execute-ok', () => executions.execute(first.id, now));
    expect(ok.status).toBe('executed');

    labels.state.executeThrows = true; labels.state.writeLabel = { projectId: 'p1', name: 'bug' };
    let failed: Awaited<ReturnType<typeof executions.execute>> | undefined;
    try {
      failed = await runInAuditScope('test:execute-fail', () => executions.execute(second.id, now));
    } catch (error) {
      expect(error).not.toBeInstanceOf(UnauditedWriteError);
      throw error;
    }
    expect(failed.status).toBe('failed');
    expect(await db.label.count({ where: { name: 'bug' } })).toBe(0);
  });

  it('AC-14: a global role.manage request runs after a global admin approves', async () => {
    await grantKeys(db, agent, ['role.manage'], null); await grantRole(db, user, 'admin', null);
    const r = await open('l1', true);
    expect((await decide(r.id)).status).toBe('executed');
    expect(roles.state.calls).toEqual([{ roleId: 'r1' }]);
  });

  it('AC-15: two concurrent executes run the command once', async () => {
    const r = await open(); await moveToApproved(r.id);
    const results = await Promise.allSettled([executions.execute(r.id, now), executions.execute(r.id, now)]);
    const fulfilled = results.filter((result) => result.status === 'fulfilled');
    const rejected = results.filter((result) => result.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(fulfilled[0].value.status).toBe('executed');
    expect(rejected[0].reason).toBeInstanceOf(ApprovalRequestNotPendingError);
    expect(labels.state.calls).toHaveLength(1);
  });

  it('AC-15: when the first of two concurrent executes fails, the command still runs once', async () => {
    labels.state.executeThrows = true; labels.state.writeLabel = { projectId: 'p1', name: 'bug' };
    const r = await open(); await moveToApproved(r.id);
    const results = await Promise.allSettled([executions.execute(r.id, now), executions.execute(r.id, now)]);
    expect(labels.state.calls).toHaveLength(1);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.filter((result) => result.status === 'rejected');
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toBeInstanceOf(ApprovalRequestNotPendingError);
    expect(await stored(r.id)).toMatchObject({ status: 'failed', result: { error: 'execution-failed', name: 'Error' } });
    expect(await db.label.count({ where: { name: 'bug' } })).toBe(0);
  });
});
