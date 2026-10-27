import { Logger } from '@nestjs/common';
import { createMock } from '@golevelup/ts-vitest';
import type { ITransactionManager } from '@nathapp/nestjs-data';
import { ApprovalRequestQueries } from '../../../approvals/approval-request.queries';
import type { ApprovalRequestRecord } from '../../../approvals/domain/approval.domain';
import { APPROVAL_REQUEST_CHANGED } from '../../../approvals/approval-request-events';
import { FanOutPublisher } from '../../../outbox/fan-out-publisher';
import { ThreadEventBus } from '../../../live/thread-event-bus';
import type { AssistantActionRequestRepository, AssistantActionRequestRecord } from './assistant-action-request.domain';
import { AssistantActionOutcomeSubscriber } from './assistant-action-outcome.subscriber';

describe('AssistantActionOutcomeSubscriber', () => {
  const payload = { requestId: 'r1', status: 'executed', permissionKey: 'ticket.comment', actorId: 'a1' };
  let links: ReturnType<typeof createMock<AssistantActionRequestRepository>>;
  let queries: ReturnType<typeof createMock<ApprovalRequestQueries>>;
  let bus: ThreadEventBus;
  let publisher: FanOutPublisher;
  let tx: ReturnType<typeof createMock<ITransactionManager>>;
  let inTransaction: boolean;
  let link: AssistantActionRequestRecord;

  beforeEach(() => {
    links = createMock<AssistantActionRequestRepository>();
    queries = createMock<ApprovalRequestQueries>();
    bus = new ThreadEventBus();
    publisher = new FanOutPublisher({ recordLastError: vi.fn() });
    inTransaction = false;
    tx = createMock<ITransactionManager>({ run: vi.fn(async (fn) => {
      inTransaction = true;
      try { return await fn(); } finally { inTransaction = false; }
    }) });
    link = { requestId: 'r1', threadId: 't1', jobId: null, toolCallId: null, tool: 'koda_add_comment', preview: '',
      noteMessageId: null, notedAt: null, deliveredAt: null, deliveredMessageId: null, createdAt: new Date() };
    links.findByRequest.mockResolvedValue(link);
    links.lockThread.mockResolvedValue(true);
    links.lockByRequest.mockResolvedValue(link);
    links.insertSystemNote.mockResolvedValue('m1');
    queries.findById.mockResolvedValue(createMock<ApprovalRequestRecord>({ id: 'r1', status: 'executed', result: { text: 'comment c1 added' } }));
    new AssistantActionOutcomeSubscriber(publisher, links, queries, tx, bus).onModuleInit();
  });
  const record = (p: unknown) => ({ id: 'e1', type: APPROVAL_REQUEST_CHANGED, payload: p });
  // FanOutPublisher uses only these record fields; use its public argument type to include library defaults.
  const publish = (p: unknown) => publisher.publish(record(p) as Parameters<FanOutPublisher['publish']>[0]);

  afterEach(() => { vi.restoreAllMocks(); });
  it('AC-9: warns exactly once and skips a malformed payload', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockClear();
    await publish({ requestId: 'r1' });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(links.findByRequest).not.toHaveBeenCalled();
  });
  it('AC-1,2,7: writes and marks in one transaction, then emits message and thread', async () => {
    const frames: unknown[] = [];
    bus.subscribe('t1', (frame) => {
      expect(inTransaction).toBe(false);
      expect(links.markNoted).toHaveBeenCalledWith('r1', 'm1', expect.any(Date));
      frames.push(frame);
    });
    links.insertSystemNote.mockImplementation(async () => {
      expect(inTransaction).toBe(true);
      expect(links.lockThread).toHaveBeenCalledWith('t1');
      expect(links.lockByRequest).toHaveBeenCalledWith('r1');
      return 'm1';
    });
    await publish(payload);
    expect(links.insertSystemNote).toHaveBeenCalledWith('t1', 'Action r1 (koda_add_comment) was approved and done: comment c1 added');
    expect(frames).toEqual([
      expect.objectContaining({ type: 'message', threadId: 't1', messageId: 'm1' }),
      expect.objectContaining({ type: 'thread', threadId: 't1' }),
    ]);
  });
  it('AC-3: skips a link already noted under lock', async () => {
    links.lockByRequest.mockResolvedValue({ ...link, notedAt: new Date() });
    await publish(payload);
    expect(links.insertSystemNote).not.toHaveBeenCalled();
  });
  it('AC-4: skips an unlinked request', async () => {
    links.findByRequest.mockResolvedValue(null);
    await publish(payload);
    expect(tx.run).not.toHaveBeenCalled();
  });
  it('AC-5: skips a link without a thread', async () => {
    links.findByRequest.mockResolvedValue({ ...link, threadId: null });
    await publish(payload);
    expect(tx.run).not.toHaveBeenCalled();
  });
  it.each(['pending', 'approved', 'unknown'])('AC-6: ignores %s events', async (status) => {
    await publish({ ...payload, status });
    expect(links.findByRequest).not.toHaveBeenCalled();
  });
  it('AC-8: skips a deleted thread found between lookup and lock', async () => {
    links.lockThread.mockResolvedValue(false);
    await publish(payload);
    expect(links.lockByRequest).not.toHaveBeenCalled();
    expect(links.insertSystemNote).not.toHaveBeenCalled();
  });
  it('skips a link removed before its lock', async () => {
    links.lockByRequest.mockResolvedValue(null);
    await publish(payload);
    expect(links.insertSystemNote).not.toHaveBeenCalled();
  });
  it('reads canonical request status instead of trusting an old terminal event', async () => {
    queries.findById.mockResolvedValue(createMock<ApprovalRequestRecord>({ id: 'r1', status: 'cancelled', result: null }));
    await publish(payload);
    expect(links.insertSystemNote).toHaveBeenCalledWith('t1', 'Action r1 (koda_add_comment) was cancelled.');
  });
  it('propagates database failures to fan-out retry and emits no frames', async () => {
    links.markNoted.mockRejectedValue(new Error('database down'));
    const frame = vi.fn();
    bus.subscribe('t1', frame);
    await expect(publish(payload)).rejects.toThrow('database down');
    expect(frame).not.toHaveBeenCalled();
  });
});
