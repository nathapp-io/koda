import type { ITransactionManager } from '@nathapp/nestjs-data';
import { ApprovalAskService, type OpenAsk } from './approval-ask.service';
import { ApprovalCommandRegistry } from './approval-command.registry';
import { DEFAULT_APPROVAL_TIMEOUT_SEC, type ApprovalPolicyRecord, type ApprovalRequestRecord, type ApprovalRequestStatus } from './domain/approval.domain';
import { ApprovalRequestNotPendingError, UnregisteredApprovalCommandError } from './domain/approval.errors';
import { approvalInputHash } from './approval-input';
import type { ResolvedApproval } from './approval-policy.resolver';
import { configurableTestCommand } from './test-helpers/test-approval-command';
import { currentBookkeepingReason } from '../action-context/audit-coverage';
import { runWithActionContext } from '../action-context/action-context';

const now = new Date('2026-11-05T09:00:00Z');
const secondsAfter = (base: Date, seconds: number) => new Date(base.getTime() + seconds * 1000);
const input = { jobId: 'j1' };

const bashAsk = (patch: Partial<OpenAsk> = {}): OpenAsk => ({
  key: 'fleet.job.shell.escalate',
  projectId: 'p1',
  component: 'runner',
  onBehalfOf: { type: 'USER', id: 'u1' },
  origin: 'runner',
  input,
  deadline: null,
  ...patch,
});
const budgetAsk = (patch: Partial<OpenAsk> = {}): OpenAsk => ({
  key: 'fleet.budget.override',
  projectId: 'p1',
  component: 'budget',
  onBehalfOf: null,
  origin: 'system',
  input: { policyId: 'b1' },
  deadline: null,
  ...patch,
});

describe('ApprovalAskService', () => {
  let registry: ApprovalCommandRegistry;
  let shell: ReturnType<typeof configurableTestCommand>;
  let budget: ReturnType<typeof configurableTestCommand>;
  let tickets: ReturnType<typeof configurableTestCommand>;
  let resolve: ReturnType<typeof vi.fn<(args: unknown) => Promise<ResolvedApproval>>>;
  let requests: {
    create: ReturnType<typeof vi.fn<(record: ApprovalRequestRecord) => Promise<ApprovalRequestRecord>>>;
    lockById: ReturnType<typeof vi.fn<(id: string) => Promise<ApprovalRequestRecord | null>>>;
    lockByIdSkipLocked: ReturnType<typeof vi.fn<(id: string) => Promise<ApprovalRequestRecord | null>>>;
    transition: ReturnType<typeof vi.fn<(id: string, from: ApprovalRequestStatus, patch: Partial<ApprovalRequestRecord>) => Promise<ApprovalRequestRecord | null>>>;
  };
  let events: { record: ReturnType<typeof vi.fn> };
  let transactions: { isInTransaction: ReturnType<typeof vi.fn>; run: ReturnType<typeof vi.fn> };
  let asks: ApprovalAskService;

  beforeEach(() => {
    registry = new ApprovalCommandRegistry();
    shell = configurableTestCommand('fleet.job.shell.escalate');
    budget = configurableTestCommand('fleet.budget.override');
    tickets = configurableTestCommand('ticket.delete');
    registry.register(shell.command);
    registry.register(budget.command);
    registry.register(tickets.command);
    resolve = vi.fn().mockResolvedValue({ mode: 'agent', floor: 'none', policy: null, source: 'default' });
    requests = {
      create: vi.fn(async (record: ApprovalRequestRecord) => record),
      lockById: vi.fn<(id: string) => Promise<ApprovalRequestRecord | null>>().mockResolvedValue(null),
      lockByIdSkipLocked: vi.fn<(id: string) => Promise<ApprovalRequestRecord | null>>().mockResolvedValue(null),
      transition: vi.fn<(id: string, from: ApprovalRequestStatus, patch: Partial<ApprovalRequestRecord>) => Promise<ApprovalRequestRecord | null>>().mockResolvedValue(null),
    };
    events = { record: vi.fn().mockResolvedValue(undefined) };
    transactions = { isInTransaction: vi.fn(() => true), run: vi.fn() };
    asks = new ApprovalAskService(
      registry,
      { resolve },
      requests,
      events as never,
      transactions as unknown as ITransactionManager,
    );
  });
  const nothingWritten = () => {
    expect(requests.create).not.toHaveBeenCalled();
    expect(events.record).not.toHaveBeenCalled();
  };
  const created = (): ApprovalRequestRecord => {
    const record = requests.create.mock.calls[0]?.[0];
    if (record === undefined) throw new Error('expected the ask to create a request');
    return record;
  };

  it('AC-4: caps expiresAt at a deadline inside the default timeout', async () => {
    const deadline = secondsAfter(now, 60);

    const outcome = await asks.open(bashAsk({ deadline }), now);

    expect(outcome.status).toBe('pending');
    expect(created().expiresAt.getTime()).toBe(deadline.getTime());
    expect(created().policyId).toBeNull();
  });

  it('AC-5: a policy timeout wins over a later deadline', async () => {
    resolve.mockResolvedValue({
      mode: 'agent', floor: 'none',
      policy: policyRecord({ timeoutSec: 120 }),
      source: 'policy',
    });

    await asks.open(bashAsk({ deadline: secondsAfter(now, 600) }), now);

    expect(created().expiresAt.getTime()).toBe(secondsAfter(now, 120).getTime());
  });

  it('AC-6: no deadline uses the engine default of 86 400 seconds', async () => {
    expect(DEFAULT_APPROVAL_TIMEOUT_SEC).toBe(86_400);

    await asks.open(bashAsk({ deadline: null }), now);

    expect(created().expiresAt.getTime()).toBe(secondsAfter(now, 86_400).getTime());
  });

  it('AC-7: a deadline before now still opens a pending request at that deadline', async () => {
    const deadline = secondsAfter(now, -1);

    const outcome = await asks.open(bashAsk({ deadline }), now);

    expect(outcome.status).toBe('pending');
    expect(created().expiresAt.getTime()).toBe(deadline.getTime());
    expect(created().status).toBe('pending');
  });

  it('AC-8: a policy that needs no approval answers the parsed input and writes nothing', async () => {
    resolve.mockResolvedValue({ mode: 'none', floor: 'none', policy: null, source: 'default' });

    const outcome = await asks.open<{ jobId: string }>(bashAsk(), now);

    expect(outcome).toEqual({ status: 'not-needed', input: { jobId: 'j1' } });
    expect(resolve).toHaveBeenCalledExactlyOnceWith({
      key: 'fleet.job.shell.escalate', projectId: 'p1', subject: { type: 'USER', id: 'u1' },
    });
    nothingWritten();
  });

  it('AC-9: a budget ask with nobody on behalf resolves as the SYSTEM component', async () => {
    await asks.open(budgetAsk(), now);

    expect(resolve).toHaveBeenCalledExactlyOnceWith({
      key: 'fleet.budget.override', projectId: 'p1', subject: { type: 'SYSTEM', id: 'budget' },
    });
  });

  it('AC-10: an ask on behalf of an agent resolves as that agent', async () => {
    await asks.open(bashAsk({ onBehalfOf: { type: 'AGENT', id: 'a1' } }), now);

    expect(resolve).toHaveBeenCalledExactlyOnceWith({
      key: 'fleet.job.shell.escalate', projectId: 'p1', subject: { type: 'AGENT', id: 'a1' },
    });
  });

  it("AC-11: refuses to run outside the caller's transaction", async () => {
    transactions.isInTransaction.mockReturnValue(false);

    await expect(asks.open(bashAsk(), now)).rejects.toThrow("approval ask needs the caller's transaction");
    expect(resolve).not.toHaveBeenCalled();
    nothingWritten();
  });

  it('AC-12: refuses a key with no registered command', async () => {
    asks = new ApprovalAskService(
      new ApprovalCommandRegistry(), { resolve }, requests, events as never,
      transactions as unknown as ITransactionManager,
    );

    await expect(asks.open(bashAsk(), now)).rejects.toEqual(new UnregisteredApprovalCommandError('fleet.job.shell.escalate'));
    expect(resolve).not.toHaveBeenCalled();
    nothingWritten();
  });

  it('AC-13: refuses a key the component does not raise, before resolving', async () => {
    await expect(asks.open(bashAsk({ key: 'ticket.delete', input: { labelId: 'l1' } }), now))
      .rejects.toThrow('approval ask key ticket.delete is not raised by runner');
    expect(resolve).not.toHaveBeenCalled();
    nothingWritten();
  });

  it('AC-14: refuses a project-scope ask with no project, before resolving', async () => {
    await expect(asks.open(bashAsk({ projectId: null }), now))
      .rejects.toThrow('approval ask needs a project for key fleet.job.shell.escalate');
    expect(resolve).not.toHaveBeenCalled();
    nothingWritten();
  });

  it('AC-15: a parse refusal propagates and nothing is resolved or written', async () => {
    shell.state.parseThrows = true;

    await expect(asks.open(bashAsk(), now)).rejects.toThrow('test parse refused');

    expect(resolve).not.toHaveBeenCalled();
    nothingWritten();
  });

  it('opens the request as the SYSTEM component with the frozen input, under the open bookkeeping reason', async () => {
    resolve.mockResolvedValue({
      mode: 'agent', floor: 'none',
      policy: policyRecord({ approverMustHoldAction: false, requireDistinctApprover: true }),
      source: 'policy',
    });
    requests.create.mockImplementation(async (record: ApprovalRequestRecord) => {
      expect(currentBookkeepingReason()).toBe('approval.request-open');
      expect(events.record).not.toHaveBeenCalled();
      return record;
    });

    const outcome = await runWithActionContext(
      { actor: { type: 'RUNNER', id: 'r1' }, origin: 'runner', correlationId: 'correlation' },
      () => asks.open(bashAsk(), now),
    );

    expect(outcome).toMatchObject({ status: 'pending', request: { id: expect.any(String) } });
    expect(created()).toMatchObject({
      permissionKey: 'fleet.job.shell.escalate', projectId: 'p1',
      actor: { type: 'SYSTEM', id: 'runner' }, onBehalfOf: { type: 'USER', id: 'u1' },
      origin: 'runner', correlationId: 'correlation', input: { jobId: 'j1' },
      requiredMode: 'agent', policyId: 'policy-1', onTimeout: 'reject',
      approverMustHoldAction: false, requireDistinctApprover: true,
      status: 'pending', satisfiedBy: null, approverType: null, approverId: null,
      decidedAt: null, settledAt: null, result: null, createdAt: now,
    });
    expect(created().inputHash).toBe(approvalInputHash({ jobId: 'j1' }));
    expect(events.record).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ status: 'pending' }));
    // The caller owns the transaction; the service must never open (or nest) one.
    expect(transactions.run).not.toHaveBeenCalled();
    expect(shell.state.calls).toEqual([]);
  });

  it('mints a correlation id when the caller runs no context', async () => {
    await asks.open(bashAsk(), now);

    expect(created().correlationId).toMatch(/^[0-9a-f-]{36}$/);
  });

  const pendingRecord = async (): Promise<ApprovalRequestRecord> => {
    await asks.open(bashAsk(), now);
    return created();
  };

  it('AC-5: locks a pending ask with SKIP LOCKED, never with the blocking lock', async () => {
    const record = await pendingRecord();
    requests.lockByIdSkipLocked.mockResolvedValue(record);
    requests.transition.mockResolvedValue({ ...record, status: 'cancelled' });

    await expect(asks.close(record.id, { status: 'cancelled', reason: 'job_ended' }, now))
      .resolves.toMatchObject({ id: record.id, status: 'cancelled' });

    // A blocking lock would wait on the decide or execute that holds the row: the close answers null.
    expect(requests.lockByIdSkipLocked).toHaveBeenCalledExactlyOnceWith(record.id);
    expect(requests.lockById).not.toHaveBeenCalled();
  });

  it('AC-6: returns null when the request is gone without transitioning', async () => {
    const result = await asks.close('missing', { status: 'cancelled', reason: 'job_ended' }, now);

    expect(result).toBeNull();
    expect(requests.lockByIdSkipLocked).toHaveBeenCalledExactlyOnceWith('missing');
    expect(requests.transition).not.toHaveBeenCalled();
  });

  it('AC-7: returns null for a non-pending request without transitioning', async () => {
    const record = await pendingRecord();
    requests.lockByIdSkipLocked.mockResolvedValue({ ...record, status: 'executed' });

    await expect(asks.close(record.id, { status: 'cancelled', reason: 'job_ended' }, now)).resolves.toBeNull();
    expect(requests.transition).not.toHaveBeenCalled();
  });

  it.each([
    ['AC-8: assistant system request is not an ask', { type: 'SYSTEM', id: 'assistant' } as const],
    ['AC-9: principal request is not an ask', { type: 'AGENT', id: 'a1' } as const],
  ])('%s', async (_title, actor) => {
    const record = await pendingRecord();
    requests.lockByIdSkipLocked.mockResolvedValue({ ...record, actor });

    await expect(asks.close(record.id, { status: 'cancelled', reason: 'job_ended' }, now))
      .rejects.toThrow('approval ask close: not an ask');
    expect(requests.transition).not.toHaveBeenCalled();
  });

  it.each(['', 'x'.repeat(65)])('AC-10/11: rejects invalid reason %j', async (reason) => {
    const record = await pendingRecord();
    requests.lockByIdSkipLocked.mockResolvedValue(record);

    await expect(asks.close(record.id, { status: 'cancelled', reason }, now))
      .rejects.toThrow('approval ask close: invalid reason');
    expect(requests.transition).not.toHaveBeenCalled();
  });

  it('AC-12: throws when transition loses despite the locked pending row', async () => {
    const record = await pendingRecord();
    requests.lockByIdSkipLocked.mockResolvedValue(record);
    requests.transition.mockResolvedValue(null);
    events.record.mockClear();

    await expect(asks.close(record.id, { status: 'cancelled', reason: 'job_ended' }, now))
      .rejects.toEqual(new ApprovalRequestNotPendingError('pending'));
    expect(events.record).not.toHaveBeenCalled();
  });

  it('AC-13: refuses to close outside the caller transaction', async () => {
    transactions.isInTransaction.mockReturnValue(false);

    await expect(asks.close('r1', { status: 'cancelled', reason: 'job_ended' }, now))
      .rejects.toThrow("approval ask needs the caller's transaction");
    expect(requests.lockByIdSkipLocked).not.toHaveBeenCalled();
    expect(requests.lockById).not.toHaveBeenCalled();
  });
});

function policyRecord(patch: Partial<ApprovalPolicyRecord> = {}): ApprovalPolicyRecord {
  return {
    id: 'policy-1', selector: 'p1|fleet.job.shell.escalate|all', projectId: 'p1',
    permissionPattern: 'fleet.job.shell.escalate', principalType: null, roleId: null, principalId: null,
    mode: 'agent', timeoutSec: null, onTimeout: 'approve', requiredApprovals: 1,
    approverMustHoldAction: true, requireDistinctApprover: false,
    updatedByType: 'USER', updatedById: 'u1', createdAt: now, updatedAt: now,
    ...patch,
  };
}
