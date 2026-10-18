/**
 * Fleet S5b 2a US-001: the propose service's post-commit behaviour and the branches the DB-backed spec
 * cannot force (a bone-fide vanished thread, a failed commit). The repository, the approval closer and
 * both buses are mocks here, so every assertion is about what the service decides, not about SQL.
 */
import { NotFoundAppException } from '@nathapp/nestjs-common';
import type { LiveFleetApprovalEvent } from '../../../live/live-event';
import { AssistantActionService } from './assistant-action.service';
import { ACTION_TTL_MS, MAX_PENDING_ACTIONS, type NewPendingAction, type PendingActionRecord, type ProposeInput } from './pending-action.domain';

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
      actorType: 'user', actorId: action.requestedById, origin: 'thread', approvalMode: 'human', approverType: null, approverId: null,
      ...action, id: 'act1', projectSlug: 'web', status: 'PENDING', approvalId: null,
      decidedById: null, decidedAt: null, result: null, deliveredAt: null, createdAt: NOW,
    })),
    setApprovalId: vi.fn(async () => undefined),
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
  requestedById: 'u1', now: NOW, ...over,
});

const storedAction = (over: Partial<PendingActionRecord> = {}): PendingActionRecord => ({
  actorType: 'user', actorId: 'u1', origin: 'thread', approvalMode: 'human', approverType: null, approverId: null,
  id: 'act9', projectId: 'p1', projectSlug: 'web', threadId: 't1', jobId: 'j1', toolCallId: 'tc1', tool: 'koda_add_comment',
  input: { ref: 'KODA-1', body: 'hello' }, preview: 'preview', status: 'PENDING', requestedById: 'u1', approvalId: 'ap1',
  decidedById: null, decidedAt: null, result: null, deliveredAt: null, expiresAt: new Date(NOW.getTime() + ACTION_TTL_MS),
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
      projectId: 'p1', threadId: 't7', jobId: 'j1', toolCallId: 'tc1', tool: 'koda_add_comment', requestedById: 'u1',
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
