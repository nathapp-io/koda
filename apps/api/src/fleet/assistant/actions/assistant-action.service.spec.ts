/**
 * Fleet S5b 2a US-001: the propose service's post-commit behaviour and the branches the DB-backed spec
 * cannot force (a bone-fide vanished thread, a failed commit). The repository, the approval closer and
 * both buses are mocks here, so every assertion is about what the service decides, not about SQL.
 */
import { NotFoundAppException } from '@nathapp/nestjs-common';
import { currentBookkeepingReason } from '../../../action-context/audit-coverage';
import type { LiveFleetApprovalEvent } from '../../../live/live-event';
import { AssistantActionService } from './assistant-action.service';
import { ACTION_TTL_MS, MAX_PENDING_ACTIONS, type DirectActionInput, type NewPendingAction, type PendingActionRecord, type ProposeInput } from './pending-action.domain';

const NOW = new Date('2026-10-23T09:00:00.000Z');
const LIVE: LiveFleetApprovalEvent[] = [
  { id: 'live-1', type: 'fleet_approval', projectId: 'p1', approvalId: 'ap1', status: 'pending', at: NOW.toISOString() },
];

/** A repository stub with one insert; every other method answers the empty case. */
function fakes() {
  const repo = {
    lockThread: vi.fn(async () => true),
    findByCall: vi.fn(async (): Promise<PendingActionRecord | null> => null),
    countPending: vi.fn(async () => 0),
    insert: vi.fn(async (action: NewPendingAction): Promise<PendingActionRecord> => ({
      actorType: 'user', origin: 'thread', approvalMode: 'human', approverType: null, approverId: null,
      ...action, id: 'act1', projectSlug: 'web', status: 'PENDING', approvalId: null,
      decidedAt: null, result: null, deliveredAt: null, createdAt: NOW,
    })),
    setApprovalId: vi.fn(async () => undefined),
    insertDirect: vi.fn(async (_input: DirectActionInput): Promise<{ id: string }> => ({ id: 'ad1' })),
  };
  const closer = { openAssistant: vi.fn(async () => ({ approval: { id: 'ap1' }, live: LIVE })) };
  const live = { publish: vi.fn() };
  const threads = { publish: vi.fn() };
  const tx = {
    run: vi.fn((fn: () => Promise<unknown>) => fn()),
    getClient: vi.fn(),
    isInTransaction: vi.fn(() => false),
  };
  const executor = { attachActions: vi.fn() };
  const service = new AssistantActionService(tx as never, repo as never, closer as never, live as never, threads as never, executor as never);
  return { service, repo, closer, live, threads, tx, executor };
}

const ask = (over: Partial<ProposeInput> = {}): ProposeInput => ({
  projectId: 'p1', threadId: 't1', threadKind: 'REPO', threadProjectSlug: 'web', jobId: 'j1', toolCallId: 'tc1',
  tool: 'koda_add_comment', input: { ref: 'KODA-1', body: 'hello' }, preview: 'Add a comment to KODA-1 "Fix login":\n\nhello',
  actorId: 'u1', now: NOW, ...over,
});

const storedAction = (over: Partial<PendingActionRecord> = {}): PendingActionRecord => ({
  actorType: 'user', actorId: 'u1', origin: 'thread', approvalMode: 'human', approverType: null, approverId: null,
  id: 'act9', projectId: 'p1', projectSlug: 'web', threadId: 't1', jobId: 'j1', toolCallId: 'tc1', tool: 'koda_add_comment',
  input: { ref: 'KODA-1', body: 'hello' }, preview: 'preview', status: 'PENDING', approvalId: 'ap1',
  decidedAt: null, result: null, deliveredAt: null, expiresAt: new Date(NOW.getTime() + ACTION_TTL_MS),
  createdAt: NOW, ...over,
});

describe('AssistantActionService.propose', () => {
  it('AC-1: onModuleInit attaches this service as the executor\'s proposer (2a-D1 late binding)', () => {
    const { service, executor } = fakes();

    service.onModuleInit();

    expect(executor.attachActions).toHaveBeenCalledWith(service);
  });

  it('AC-15: publishes a thread event for the action\'s thread after the commit', async () => {
    const { service, threads, live, tx } = fakes();

    await expect(service.propose(ask())).resolves.toEqual({ actionId: 'act1' });

    expect(threads.publish).toHaveBeenCalledWith({
      id: expect.any(String), threadId: 't1', at: NOW.toISOString(), type: 'thread',
    });
    expect(live.publish).toHaveBeenCalledWith(LIVE);
    // Both buses hear about the action only once the transaction that wrote it has committed.
    expect(tx.run.mock.invocationCallOrder[0]).toBeLessThan(live.publish.mock.invocationCallOrder[0]);
    expect(tx.run.mock.invocationCallOrder[0]).toBeLessThan(threads.publish.mock.invocationCallOrder[0]);
  });

  it('publishes nothing when the transaction fails', async () => {
    const { service, repo, live, threads } = fakes();
    repo.insert.mockRejectedValueOnce(new Error('boom'));

    await expect(service.propose(ask())).rejects.toThrow('boom');

    expect(live.publish).not.toHaveBeenCalled();
    expect(threads.publish).not.toHaveBeenCalled();
  });

  it('writes the action under the thread lock, with the TTL and the approval linked back', async () => {
    const { service, repo, closer } = fakes();

    await service.propose(ask({ threadId: 't7' }));

    expect(repo.lockThread).toHaveBeenCalledWith('t7');
    expect(repo.insert).toHaveBeenCalledWith(expect.objectContaining({
      projectId: 'p1', threadId: 't7', jobId: 'j1', toolCallId: 'tc1', tool: 'koda_add_comment', actorId: 'u1',
      expiresAt: new Date(NOW.getTime() + ACTION_TTL_MS),
    }));
    expect(repo.setApprovalId).toHaveBeenCalledWith('act1', 'ap1');
    // The thread lock is taken before the duplicate read and the insert, the order allocateThreadSeq assumes.
    expect(repo.lockThread.mock.invocationCallOrder[0]).toBeLessThan(repo.findByCall.mock.invocationCallOrder[0]);
    expect(repo.findByCall.mock.invocationCallOrder[0]).toBeLessThan(repo.insert.mock.invocationCallOrder[0]);
    expect(closer.openAssistant).toHaveBeenCalledWith(expect.anything(), '/web/threads/t7', NOW);
  });

  it('AC-8/AC-9: the approval carries the thread path of the thread\'s own kind', async () => {
    const { service, closer } = fakes();

    await service.propose(ask({ threadId: 't2' }));
    await service.propose(ask({ threadId: 't3', threadKind: 'WORKSPACE', threadProjectSlug: 'ops' }));

    expect(closer.openAssistant).toHaveBeenNthCalledWith(1, expect.anything(), '/web/threads/t2', NOW);
    // A WORKSPACE thread's own page has no project prefix, whatever project the action acts in.
    expect(closer.openAssistant).toHaveBeenNthCalledWith(2, expect.anything(), '/threads/t3', NOW);
  });

  it('AC-10/AC-11: a repeated call answers the stored action id and writes nothing', async () => {
    const { service, repo, closer, live, threads } = fakes();
    repo.findByCall.mockResolvedValue(storedAction());

    await expect(service.propose(ask())).resolves.toEqual({ actionId: 'act9' });

    expect(repo.insert).not.toHaveBeenCalled();
    expect(closer.openAssistant).not.toHaveBeenCalled();
    expect(repo.setApprovalId).not.toHaveBeenCalled();
    expect(live.publish).not.toHaveBeenCalled();
    expect(threads.publish).not.toHaveBeenCalled();
  });

  it(`AC-12/AC-13: at ${MAX_PENDING_ACTIONS} pending actions the call is refused and writes nothing`, async () => {
    const { service, repo, closer, live, threads } = fakes();
    repo.countPending.mockResolvedValue(MAX_PENDING_ACTIONS);

    await expect(service.propose(ask())).resolves.toEqual({ refused: true });

    expect(repo.insert).not.toHaveBeenCalled();
    expect(closer.openAssistant).not.toHaveBeenCalled();
    expect(live.publish).not.toHaveBeenCalled();
    expect(threads.publish).not.toHaveBeenCalled();
  });

  it('one below the cap is stored', async () => {
    const { service, repo } = fakes();
    repo.countPending.mockResolvedValue(MAX_PENDING_ACTIONS - 1);

    await expect(service.propose(ask())).resolves.toEqual({ actionId: 'act1' });

    expect(repo.insert).toHaveBeenCalledTimes(1);
  });

  it('a thread that vanished under the lock answers 404 and writes nothing', async () => {
    const { service, repo, closer } = fakes();
    repo.lockThread.mockResolvedValue(false);

    await expect(service.propose(ask())).rejects.toBeInstanceOf(NotFoundAppException);

    expect(repo.findByCall).not.toHaveBeenCalled();
    expect(repo.insert).not.toHaveBeenCalled();
    expect(closer.openAssistant).not.toHaveBeenCalled();
  });
});

/** 3-D14: one write that already ran, recorded by the caller that ran it. */
const direct = (over: Partial<DirectActionInput> = {}): DirectActionInput => ({
  projectId: 'p1', tool: 'koda_add_comment', input: { ref: 'KODA-1', body: 'hello' }, preview: 'Add a comment to KODA-1',
  actorType: 'agent', actorId: 'ag1', origin: 'mcp', status: 'EXECUTED', result: 'done', now: NOW, ...over,
});

describe('AssistantActionService.recordDirect (3-D14)', () => {
  it('AC-4: answers the id of the one row it inserted, as it was given', async () => {
    const { service, repo } = fakes();

    await expect(service.recordDirect(direct())).resolves.toEqual({ actionId: 'ad1' });

    expect(repo.insertDirect).toHaveBeenCalledTimes(1);
    expect(repo.insertDirect).toHaveBeenCalledWith(direct());
  });

  it('AC-8: opens no approval, takes no thread lock and publishes on neither bus', async () => {
    const { service, repo, closer, live, threads } = fakes();

    await service.recordDirect(direct());

    expect(closer.openAssistant).not.toHaveBeenCalled();
    expect(live.publish).not.toHaveBeenCalled();
    expect(threads.publish).not.toHaveBeenCalled();
    expect(repo.lockThread).not.toHaveBeenCalled();
    expect(repo.insert).not.toHaveBeenCalled();
    expect(repo.setApprovalId).not.toHaveBeenCalled();
  });

  it('AC-9: a failed call is stored with the caller\'s own failure text', async () => {
    const { service, repo } = fakes();

    await service.recordDirect(direct({ status: 'FAILED', result: 'not_found' }));

    expect(repo.insertDirect).toHaveBeenCalledWith(expect.objectContaining({ status: 'FAILED', result: 'not_found' }));
  });

  it('a failed insert is not swallowed', async () => {
    const { service, repo } = fakes();
    repo.insertDirect.mockRejectedValueOnce(new Error('boom'));

    await expect(service.recordDirect(direct())).rejects.toThrow('boom');
  });
});

/**
 * Permissions P2 US-007: a proposal's rows — the pending action, its approval and the approval id link — are the
 * record of an action that has not run yet, so those three writes are bookkeeping.
 */
describe('AssistantActionService audit coverage (permissions P2 US-007)', () => {
  type Reason = ReturnType<typeof currentBookkeepingReason>;

  /** Records the bookkeeping reason current at each call of a stub, then answers exactly as the stub did. */
  function watching<T>(fn: T, seen: Reason[]): T {
    const mock = fn as unknown as {
      getMockImplementation(): ((...args: never[]) => unknown) | undefined;
      mockImplementation(impl: (...args: never[]) => unknown): void;
    };
    const impl = mock.getMockImplementation();
    mock.mockImplementation((...args: never[]) => {
      seen.push(currentBookkeepingReason());
      return impl?.(...args);
    });
    return fn;
  }

  it('AC-15: propose inserts the action and opens its approval under assistant.action-proposal', async () => {
    const { service, repo, closer } = fakes();
    const inserted: Reason[] = [];
    const opened: Reason[] = [];
    const linked: Reason[] = [];
    watching(repo.insert, inserted);
    watching(closer.openAssistant, opened);
    watching(repo.setApprovalId, linked);

    await expect(service.propose(ask())).resolves.toEqual({ actionId: 'act1' });

    expect(inserted).toEqual(['assistant.action-proposal']);
    expect(opened).toEqual(['assistant.action-proposal']);
    expect(linked).toEqual(['assistant.action-proposal']);
  });

  it('keeps the thread lock and the duplicate read counted, outside the marker', async () => {
    const { service, repo } = fakes();
    const locks: Reason[] = [];
    const reads: Reason[] = [];
    watching(repo.lockThread, locks);
    watching(repo.findByCall, reads);

    await service.propose(ask());

    expect(locks).toEqual([undefined]);
    expect(reads).toEqual([undefined]);
  });

  it('leaves no reason current once the proposal has resolved', async () => {
    const { service } = fakes();

    await service.propose(ask());

    expect(currentBookkeepingReason()).toBeUndefined();
  });
});

/** 3-D14: the record of a direct write is the caller's own ledger row, so it is bookkeeping as a whole. */
describe('AssistantActionService.recordDirect audit coverage (permissions P2 US-007)', () => {
  type Reason = ReturnType<typeof currentBookkeepingReason>;

  it('records the direct action under assistant.direct-action-record', async () => {
    const { service, repo } = fakes();
    const seen: Reason[] = [];
    const impl = repo.insertDirect.getMockImplementation() as (input: DirectActionInput) => Promise<{ id: string }>;
    repo.insertDirect.mockImplementation(async (input: DirectActionInput) => {
      seen.push(currentBookkeepingReason());
      return impl(input);
    });

    await expect(service.recordDirect(direct())).resolves.toEqual({ actionId: 'ad1' });

    expect(seen).toEqual(['assistant.direct-action-record']);
    expect(currentBookkeepingReason()).toBeUndefined();
  });
});
