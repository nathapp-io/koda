import { randomUUID } from 'node:crypto';
import type { NathApplication } from '@nathapp/nestjs-app';
import { runWithActionContext } from '../../../src/action-context/action-context';
import { UnauditedWriteError, runInAuditScope } from '../../../src/action-context/audit-coverage';
import { ApprovalCommandRegistry } from '../../../src/approvals/approval-command.registry';
import { ApprovalGate } from '../../../src/approvals/approval-gate.service';
import { ApprovalPolicyService } from '../../../src/approvals/approval-policy.service';
import { DEFAULT_APPROVAL_TIMEOUT_SEC, type ApprovalRequestRecord } from '../../../src/approvals/domain/approval.domain';
import { grantKeys } from '../../../src/approvals/test-helpers/approval-fixtures';
import { configurableTestCommand } from '../../../src/approvals/test-helpers/test-approval-command';
import { grantRole } from '../../../src/permissions/test-helpers/permission-fixtures';
import { fixtureDb, withTestActor } from '../../helpers/action-context';
import { bootHttpApp } from '../../helpers/http-app';
import { resetDb } from '../../helpers/reset-db';
import { canRunDbTests } from '../../helpers/test-environment';

const labelInput = { labelId: 'l1' };
const opts = { projectId: 'p1' };
const now = new Date('2026-11-05T09:00:00Z');
const secondsAfter = (base: Date, seconds: number) => new Date(base.getTime() + seconds * 1000);

(canRunDbTests() ? describe : describe.skip)('ApprovalGate pending requests through AppModule', () => {
  let app: NathApplication;
  let gate: ApprovalGate;
  let policies: ApprovalPolicyService;
  let db: ReturnType<typeof fixtureDb>;
  const labels = configurableTestCommand('label.delete');
  const roles = configurableTestCommand('role.manage');

  const agent = <T>(fn: () => Promise<T>) => withTestActor({ type: 'AGENT', id: 'a1' }, fn);
  const user = <T>(fn: () => Promise<T>) => withTestActor({ type: 'USER', id: 'u1' }, fn);
  const assistant = (onBehalfOfUserId: string) => runWithActionContext(
    { actor: { type: 'SYSTEM', id: 'assistant' }, onBehalfOf: { type: 'USER', id: onBehalfOfUserId }, origin: 'thread' },
    () => gate.gate('label.delete', labelInput, opts, now),
  );
  const openLabelRequest = async (): Promise<ApprovalRequestRecord> => {
    const outcome = await agent(() => gate.gate('label.delete', labelInput, opts, now));
    if (outcome.status !== 'pending') throw new Error(`expected a pending outcome, got ${outcome.status}`);
    return outcome.request;
  };

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    db = fixtureDb(app);
    await db.project.create({ data: { id: 'p1', slug: 'gate-pending-p1', key: 'GATP', name: 'Pending gate project' } });
    gate = app.get(ApprovalGate, { strict: false });
    policies = app.get(ApprovalPolicyService, { strict: false });
    const registry = app.get(ApprovalCommandRegistry, { strict: false });
    registry.register(labels.command);
    registry.register(roles.command);
  });
  afterAll(async () => { await app?.close(); });
  beforeEach(async () => {
    labels.reset();
    roles.reset();
    await db.approvalRequest.deleteMany();
    await db.approvalPolicy.deleteMany();
    await db.roleBinding.deleteMany({ where: { principalType: 'AGENT', principalId: 'a1' } });
  });

  it('AC-1: opens a pending request instead of running the command', async () => {
    const request = await openLabelRequest();
    expect(request).toMatchObject({
      status: 'pending',
      requiredMode: 'agent',
      permissionKey: 'label.delete',
      projectId: 'p1',
      input: { labelId: 'l1' },
      actor: { type: 'AGENT', id: 'a1' },
      satisfiedBy: null,
      approverType: null,
      approverId: null,
    });
    expect(labels.state.calls).toEqual([]);
    expect(await db.approvalRequest.count()).toBe(1);
  });

  it('AC-2: snapshots the default timeout and the no-policy flags', async () => {
    const request = await openLabelRequest();
    expect(DEFAULT_APPROVAL_TIMEOUT_SEC).toBe(86_400);
    expect(request.expiresAt.getTime()).toBe(secondsAfter(now, 86_400).getTime());
    expect(request).toMatchObject({
      onTimeout: 'reject',
      approverMustHoldAction: true,
      requireDistinctApprover: false,
      policyId: null,
    });
  });

  it('AC-3: snapshots the resolved policy settings and its timeout', async () => {
    const policy = await user(() => policies.create({
      projectId: 'p1', permissionPattern: 'label.delete', appliesTo: { kind: 'all' },
      mode: 'self', timeoutSec: 600, requireDistinctApprover: true,
    }));
    const request = await openLabelRequest();
    expect(request).toMatchObject({
      requiredMode: 'self',
      requireDistinctApprover: true,
      approverMustHoldAction: true,
      onTimeout: 'reject',
      policyId: policy.id,
    });
    expect(request.expiresAt.getTime()).toBe(secondsAfter(now, 600).getTime());
    expect(labels.state.calls).toEqual([]);
  });

  it('AC-4: returns the still-pending request for a retried gate call', async () => {
    const first = await openLabelRequest();
    const second = await openLabelRequest();
    expect(second.id).toBe(first.id);
    expect(await db.approvalRequest.count()).toBe(1);
  });

  it('AC-5: propagates a parse error and writes no request', async () => {
    labels.state.parseThrows = true;
    const error: unknown = await agent(() => gate.gate('label.delete', labelInput, opts, now)).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(TypeError);
    expect((error as TypeError).message).toBe('test parse refused');
    expect(await db.approvalRequest.count()).toBe(0);
    expect(labels.state.calls).toEqual([]);
  });

  it('AC-6: opening a request settles under an open audit scope without UnauditedWriteError', async () => {
    const outcome = await runInAuditScope('POST /api/gate-probe', () => agent(() => gate.gate('label.delete', labelInput, opts, now)));
    expect(outcome.status).toBe('pending');
    expect(await db.approvalRequest.count()).toBe(1);
  });

  it('AC-6 control: the same scope refuses an unbookkept write', async () => {
    const create = () => agent(() => db.approvalPolicy.create({ data: {
      selector: `probe-${randomUUID()}`, permissionPattern: 'label.delete', mode: 'none',
      updatedByType: 'AGENT', updatedById: 'a1',
    } }));
    await expect(runInAuditScope('POST /api/gate-probe', create)).rejects.toBeInstanceOf(UnauditedWriteError);
  });

  it('AC-7: opens one request per on-behalf-of principal for the same input', async () => {
    const first = await assistant('u8');
    const second = await assistant('u9');
    if (first.status !== 'pending' || second.status !== 'pending') throw new Error('expected two pending outcomes');
    expect(first.request).toMatchObject({
      actor: { type: 'SYSTEM', id: 'assistant' },
      onBehalfOf: { type: 'USER', id: 'u8' },
      origin: 'thread',
      input: { labelId: 'l1' },
    });
    expect(second.request).toMatchObject({ onBehalfOf: { type: 'USER', id: 'u9' } });
    expect(second.request.id).not.toBe(first.request.id);
    expect(await db.approvalRequest.count()).toBe(2);
  });

  it('AC-8: gates a global key with no project', async () => {
    await grantKeys(db, { type: 'AGENT', id: 'a1' }, ['role.manage'], null);
    const outcome = await agent(() => gate.gate('role.manage', { roleId: 'r1' }, { projectId: null }, now));
    if (outcome.status !== 'pending') throw new Error(`expected a pending outcome, got ${outcome.status}`);
    expect(outcome.request).toMatchObject({
      permissionKey: 'role.manage',
      projectId: null,
      requiredMode: 'human',
      input: { roleId: 'r1' },
      actor: { type: 'AGENT', id: 'a1' },
    });
    expect(roles.state.calls).toEqual([]);
  });

  it('AC-9: a role policy of mode none executes at once through the real resolver', async () => {
    await grantRole(db, { type: 'AGENT', id: 'a1' }, 'developer', 'p1');
    const developer = await db.role.findUniqueOrThrow({ where: { key: 'developer' } });
    await user(() => policies.create({
      projectId: 'p1', permissionPattern: 'label.delete',
      appliesTo: { kind: 'role', roleId: developer.id }, mode: 'none',
    }));
    const outcome = await agent(() => gate.gate('label.delete', labelInput, opts, now));
    expect(outcome).toEqual({ status: 'executed', result: 'done', approval: { requiredMode: 'none', satisfiedBy: 'none' } });
    expect(labels.state.calls).toEqual([{ labelId: 'l1' }]);
    expect(await db.approvalRequest.count()).toBe(0);
  });
});
