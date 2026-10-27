import { TRANSACTION_MANAGER, type ITransactionManager } from '@nathapp/nestjs-data';
import type { NathApplication } from '@nathapp/nestjs-app';
import { ApprovalAskService, type OpenAsk } from '../../../src/approvals/approval-ask.service';
import { ApprovalCommandRegistry } from '../../../src/approvals/approval-command.registry';
import { ApprovalDecisionService } from '../../../src/approvals/approval-decision.service';
import { ApprovalPolicyService } from '../../../src/approvals/approval-policy.service';
import type { ApprovalRequestRecord } from '../../../src/approvals/domain/approval.domain';
import { ApprovalCancelForbiddenError, ApprovalDecideForbiddenError } from '../../../src/approvals/domain/approval.errors';
import { grantKeys } from '../../../src/approvals/test-helpers/approval-fixtures';
import {
  configurableTestCommand,
  installOverRegisteredCommand,
} from '../../../src/approvals/test-helpers/test-approval-command';
import { PermissionCache } from '../../../src/permissions/permission-cache';
import { grantRole } from '../../../src/permissions/test-helpers/permission-fixtures';
import { fixtureDb, withTestActor } from '../../helpers/action-context';
import { bootHttpApp } from '../../helpers/http-app';
import { resetDb } from '../../helpers/reset-db';
import { canRunDbTests } from '../../helpers/test-environment';

const now = new Date('2026-11-06T09:00:00Z');
const askedInput = { jobId: 'j1' };

/** The bash ask the runner raises for a job, on behalf of the job's requester. */
const bashAsk = (patch: Partial<OpenAsk> = {}): OpenAsk => ({
  key: 'fleet.job.shell.escalate',
  projectId: 'p1',
  component: 'runner',
  onBehalfOf: { type: 'USER', id: 'u1' },
  origin: 'runner',
  input: askedInput,
  deadline: null,
  ...patch,
});

/** The budget ask the evaluator raises when spend crosses a hard stop: no principal behind it. */
const budgetAsk = (patch: Partial<OpenAsk> = {}): OpenAsk => ({
  key: 'fleet.budget.override',
  projectId: 'p1',
  component: 'budget',
  onBehalfOf: null,
  origin: 'system',
  input: { scope: 'p1' },
  deadline: null,
  ...patch,
});

(canRunDbTests() ? describe : describe.skip)('ApprovalAskService through AppModule', () => {
  let app: NathApplication;
  let asks: ApprovalAskService;
  let policies: ApprovalPolicyService;
  let decisions: ApprovalDecisionService;
  let permissionCache: PermissionCache;
  let db: ReturnType<typeof fixtureDb>;
  let txManager: ITransactionManager;
  const shell = configurableTestCommand('fleet.job.shell.escalate');
  const budget = configurableTestCommand('fleet.budget.override');

  const user = <T>(fn: () => Promise<T>) => withTestActor({ type: 'USER', id: 'u1' }, fn);
  /** The ask joins the caller's transaction, as the fleet's job/budget lock holder opens it. */
  const open = (ask: OpenAsk) =>
    withTestActor({ type: 'RUNNER', id: 'r1' }, () => txManager.run(() => asks.open(ask, now)));
  const openBash = (ask: OpenAsk = bashAsk()) => open(ask);
  const close = (id: string, status: 'cancelled' | 'expired', reason: string) =>
    withTestActor({ type: 'RUNNER', id: 'r1' }, () => txManager.run(() => asks.close(id, { status, reason }, now)));
  /** The opened request, refusing an outcome the case does not expect. */
  const opened = async (ask: OpenAsk): Promise<ApprovalRequestRecord> => {
    const outcome = await open(ask);
    if (outcome.status !== 'pending') throw new Error(`expected a pending outcome, got ${outcome.status}`);
    return outcome.request;
  };
  const decideAs = (id: string, deciderId: string) =>
    withTestActor({ type: 'USER', id: deciderId }, () => decisions.decide(id, 'approve', null, now));
  const storedRequest = () => db.approvalRequest.findFirstOrThrow();

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    db = fixtureDb(app);
    txManager = app.get(TRANSACTION_MANAGER, { strict: false });
    await db.project.create({ data: { id: 'p1', slug: 'ask-p1', key: 'ASKP', name: 'Ask project' } });
    asks = app.get(ApprovalAskService, { strict: false });
    policies = app.get(ApprovalPolicyService, { strict: false });
    decisions = app.get(ApprovalDecisionService, { strict: false });
    permissionCache = app.get(PermissionCache, { strict: false });
    const registry = app.get(ApprovalCommandRegistry, { strict: false });
    // `ApprovalsModule` registers the production commands for the two fleet asks in `onModuleInit`,
    // and the registry refuses a second command for a key: the doubles are installed over them.
    installOverRegisteredCommand(registry, shell.command);
    installOverRegisteredCommand(registry, budget.command);
  });
  afterAll(async () => { await app?.close(); });
  beforeEach(async () => {
    shell.reset();
    budget.reset();
    await db.outboxEvent.deleteMany({ where: { type: 'approval_request_changed' } });
    await db.approvalDecision.deleteMany();
    await db.approvalRequest.deleteMany();
    await db.approvalPolicy.deleteMany();
    await db.roleBinding.deleteMany({ where: { principalType: 'USER', principalId: { in: ['u1', 'u2'] } } });
    // Fixtures bypass the membership services, so their grants must invalidate the key cache.
    await permissionCache.invalidate();
  });

  it('AC-1: opens a pending request attributed to the SYSTEM component', async () => {
    const outcome = await openBash();
    if (outcome.status !== 'pending') throw new Error(`expected a pending outcome, got ${outcome.status}`);

    const request = await storedRequest();
    expect(request).toMatchObject({
      id: outcome.request.id,
      status: 'pending',
      permissionKey: 'fleet.job.shell.escalate',
      projectId: 'p1',
      actorType: 'SYSTEM',
      actorId: 'runner',
      input: askedInput,
    });
    // The ask is raised, never executed: the caller answers the bash ask itself.
    expect(shell.state.calls).toEqual([]);
    expect(await db.outboxEvent.count({ where: { type: 'approval_request_changed' } })).toBe(1);
  });

  it('AC-2: records the requester it acts for, the runner origin and the catalog default mode', async () => {
    await openBash();

    expect(await storedRequest()).toMatchObject({
      onBehalfOfType: 'USER',
      onBehalfOfId: 'u1',
      origin: 'runner',
      requiredMode: 'agent',
      onTimeout: 'reject',
      policyId: null,
      approverMustHoldAction: true,
      requireDistinctApprover: false,
    });
  });

  it('AC-3: never approves on timeout, even when the matching policy does', async () => {
    const policy = await user(() => policies.create({
      projectId: 'p1',
      permissionPattern: 'fleet.job.shell.escalate',
      appliesTo: { kind: 'all' },
      mode: 'agent',
      onTimeout: 'approve',
    }));

    const outcome = await openBash();
    expect(outcome.status).toBe('pending');
    expect(await storedRequest()).toMatchObject({
      requiredMode: 'agent',
      onTimeout: 'reject',
      policyId: policy.id,
    });
  });

  it('AC-4: opens nothing when the policy needs no approval', async () => {
    // `fleet.budget.override` has the `self` floor, so its ask can never resolve to `none`; the
    // bash key's floor is `none`, so an explicit no-approval policy resolves the ask away.
    await user(() => policies.create({
      projectId: 'p1',
      permissionPattern: 'fleet.job.shell.escalate',
      appliesTo: { kind: 'all' },
      mode: 'none',
    }));

    const outcome = await openBash();

    expect(outcome).toEqual({ status: 'not-needed', input: askedInput });
    expect(await db.approvalRequest.count()).toBe(0);
    expect(await db.outboxEvent.count({ where: { type: 'approval_request_changed' } })).toBe(0);
    expect(shell.state.calls).toEqual([]);
  });

  it('AC-1: closes a pending ask as cancelled inside the caller transaction', async () => {
    const request = await opened(bashAsk());

    const result = await close(request.id, 'cancelled', 'job_ended');

    expect(result).toMatchObject({ id: request.id, status: 'cancelled' });
  });

  it('AC-2: persists the close timestamp and bounded reason result', async () => {
    const request = await opened(bashAsk());

    await close(request.id, 'cancelled', 'job_ended');

    expect(await db.approvalRequest.findUniqueOrThrow({ where: { id: request.id } }))
      .toMatchObject({ status: 'cancelled', settledAt: now, result: { closedBy: 'job_ended' } });
  });

  it('AC-3: closes an overdue pending ask as expired', async () => {
    const request = await opened(bashAsk());

    const result = await close(request.id, 'expired', 'timeout');

    expect(result).toMatchObject({ id: request.id, status: 'expired' });
  });

  it('AC-4: writes one status-change outbox event for close', async () => {
    const request = await opened(bashAsk());

    await close(request.id, 'cancelled', 'job_ended');

    expect(await db.outboxEvent.count({
      where: { type: 'approval_request_changed', eventId: `${request.id}:cancelled` },
    })).toBe(1);
  });

  it('AC-5: close writes no audit entry', async () => {
    const request = await opened(bashAsk());

    await close(request.id, 'cancelled', 'job_ended');

    expect(await db.auditEntry.count({ where: { resourceType: 'approval-request', resourceId: request.id } })).toBe(0);
  });

  it('US-007 AC-4: a budget ask with no requester still needs a decide permission', async () => {
    const request = await opened(budgetAsk());
    expect(request).toMatchObject({ actor: { type: 'SYSTEM', id: 'budget' }, onBehalfOf: null, requiredMode: 'agent' });
    // The action key alone, in P: neither `approval.decide` nor a narrowed decide entry.
    await grantKeys(db, { type: 'USER', id: 'u2' }, ['fleet.budget.override'], 'p1');
    await permissionCache.invalidate();

    await expect(decideAs(request.id, 'u2')).rejects.toEqual(new ApprovalDecideForbiddenError('missing-decide-permission'));

    expect((await db.approvalRequest.findUniqueOrThrow({ where: { id: request.id } })).status).toBe('pending');
    expect(await db.approvalDecision.count()).toBe(0);
    expect(budget.state.calls).toEqual([]);
  });

  it('US-007 AC-6: another developer approves a bash ask and its command runs once', async () => {
    await grantRole(db, { type: 'USER', id: 'u1' }, 'developer', 'p1');
    await grantRole(db, { type: 'USER', id: 'u2' }, 'developer', 'p1');
    await permissionCache.invalidate();
    const request = await opened(bashAsk({ onBehalfOf: { type: 'USER', id: 'u1' } }));

    const settled = await decideAs(request.id, 'u2');

    expect(settled).toMatchObject({ status: 'executed', satisfiedBy: 'human', approverType: 'USER', approverId: 'u2' });
    expect(shell.state.calls).toEqual([askedInput]);
    expect(await db.approvalRequest.findUniqueOrThrow({ where: { id: request.id } }))
      .toMatchObject({ status: 'executed' });
  });

  it('US-007 AC-7: executes an ask after the user it is on behalf of lost every role binding', async () => {
    await grantRole(db, { type: 'USER', id: 'u1' }, 'developer', 'p1');
    await grantRole(db, { type: 'USER', id: 'u2' }, 'developer', 'p1');
    await permissionCache.invalidate();
    const request = await opened(bashAsk({ onBehalfOf: { type: 'USER', id: 'u1' } }));
    await db.roleBinding.deleteMany({ where: { principalType: 'USER', principalId: 'u1' } });
    await permissionCache.invalidate();

    const settled = await decideAs(request.id, 'u2');

    // The ask was not chosen by a principal, so its requester's revoked key is not re-checked.
    expect(settled).toMatchObject({ status: 'executed' });
    expect(settled.result).toBeNull();
    expect(shell.state.calls).toEqual([askedInput]);
  });

  it('US-007 AC-10: the user an ask is on behalf of cannot cancel it', async () => {
    const request = await opened(bashAsk());

    await expect(withTestActor({ type: 'USER', id: 'u1' }, () => decisions.cancel(request.id, now)))
      .rejects.toEqual(new ApprovalCancelForbiddenError(request.id));

    expect((await storedRequest()).status).toBe('pending');
    expect(shell.state.calls).toEqual([]);
  });
});
