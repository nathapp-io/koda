import { TRANSACTION_MANAGER, type ITransactionManager } from '@nathapp/nestjs-data';
import type { NathApplication } from '@nathapp/nestjs-app';
import { ApprovalAskService, type OpenAsk } from '../../../src/approvals/approval-ask.service';
import { ApprovalCommandRegistry } from '../../../src/approvals/approval-command.registry';
import { ApprovalPolicyService } from '../../../src/approvals/approval-policy.service';
import { configurableTestCommand } from '../../../src/approvals/test-helpers/test-approval-command';
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

(canRunDbTests() ? describe : describe.skip)('ApprovalAskService through AppModule', () => {
  let app: NathApplication;
  let asks: ApprovalAskService;
  let policies: ApprovalPolicyService;
  let db: ReturnType<typeof fixtureDb>;
  let txManager: ITransactionManager;
  const shell = configurableTestCommand('fleet.job.shell.escalate');

  const user = <T>(fn: () => Promise<T>) => withTestActor({ type: 'USER', id: 'u1' }, fn);
  /** The ask joins the caller's transaction, as the fleet's job/budget lock holder opens it. */
  const openBash = (ask: OpenAsk = bashAsk()) =>
    withTestActor({ type: 'RUNNER', id: 'r1' }, () => txManager.run(() => asks.open(ask, now)));
  const storedRequest = () => db.approvalRequest.findFirstOrThrow();

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    db = fixtureDb(app);
    txManager = app.get(TRANSACTION_MANAGER, { strict: false });
    await db.project.create({ data: { id: 'p1', slug: 'ask-p1', key: 'ASKP', name: 'Ask project' } });
    asks = app.get(ApprovalAskService, { strict: false });
    policies = app.get(ApprovalPolicyService, { strict: false });
    app.get(ApprovalCommandRegistry, { strict: false }).register(shell.command);
  });
  afterAll(async () => { await app?.close(); });
  beforeEach(async () => {
    shell.reset();
    await db.outboxEvent.deleteMany({ where: { type: 'approval_request_changed' } });
    await db.approvalDecision.deleteMany();
    await db.approvalRequest.deleteMany();
    await db.approvalPolicy.deleteMany();
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
});
