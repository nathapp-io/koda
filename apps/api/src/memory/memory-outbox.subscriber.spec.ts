import type { AuditRecorder } from '../audit/audit-recorder.service';
import { currentContext, runAsSystem, type ActionContext } from '../action-context/action-context';
import { MemoryOutboxSubscriber } from './memory-outbox.subscriber';
import { ExtractionService } from './extraction.service';
import { PrismaMemoryItemRepository, type MemoryUpsertOptions } from './prisma-memory-item.repository';
import type { MemoryItem } from './memory-item-repository';
import { FanOutPublisher } from '../outbox/fan-out-publisher';
import { noopLastErrors, outboxRecord } from '../../test/helpers/outbox-record';

/** The one item the extraction stub answers: a ticket fact, as `ExtractionService` produces for `status_changed`. */
const extracted = [
  { projectId: 'p1', kind: 'FACT', subject: 'ticket:t1', predicate: 'status', object: 'IN_PROGRESS', sourceType: 'ticket_event', sourceId: 'e1', confidence: 1 },
];

/** The subscriber over a stub repository and a recording audit; `upsert` answers a stored item. */
function subscriber() {
  const registry = new FanOutPublisher(noopLastErrors);
  const extraction = { extractFromEvent: vi.fn().mockReturnValue(extracted) } as unknown as ExtractionService;
  const record = vi.fn(async (): Promise<void> => undefined);
  const audit = { record } as unknown as AuditRecorder;
  const capture: { context?: ActionContext; options?: MemoryUpsertOptions } = {};
  const upsert = vi.fn(async (_input: unknown, options?: MemoryUpsertOptions) => {
    capture.context = currentContext();
    capture.options = options;
    return { id: 'm-1', projectId: 'p1', kind: 'FACT' } as MemoryItem;
  });
  const repo = { upsert } as unknown as PrismaMemoryItemRepository;
  const instance = new MemoryOutboxSubscriber(registry, extraction, repo, audit);
  instance.onModuleInit();
  return { registry, extraction, repo, upsert, record, capture, instance };
}

/** One `ticket_event` as the relay hands it to the publisher. */
const ticketEvent = (id: string) =>
  outboxRecord('ticket_event', {
    type: 'ticket_event', id, ticketId: 't1', projectId: 'p1', actorId: 'a1',
    action: 'status_changed', data: { newStatus: 'IN_PROGRESS' }, timestamp: new Date().toISOString(),
  });

describe('MemoryOutboxSubscriber', () => {
  it('registers ticket_event and agent_event on init and persists extracted items', async () => {
    const { registry, extraction, upsert } = subscriber();

    expect(registry.getHandlers('ticket_event').length).toBe(1);
    expect(registry.getHandlers('agent_event').length).toBe(1);

    await registry.publish(ticketEvent('e1'));

    expect(extraction.extractFromEvent).toHaveBeenCalled();
    expect(upsert).toHaveBeenCalledTimes(1);
  });

  // -------------------------------------------------------------------------
  // Permissions P2 US-003 — the extraction records as SYSTEM/memory
  // -------------------------------------------------------------------------

  it('AC-16: a published ticket_event upserts as SYSTEM/memory, not as the outbox', async () => {
    const { registry, capture } = subscriber();

    await runAsSystem('outbox', async () => { await registry.publish(ticketEvent('e1')); });

    expect(capture.context?.actor).toEqual({ type: 'SYSTEM', id: 'memory' });
  });

  it('AC-17: that upsert carries an onWritten hook that records system.memory.extract-from-event', async () => {
    const { registry, capture, record } = subscriber();

    await runAsSystem('outbox', async () => { await registry.publish(ticketEvent('e1')); });

    expect(typeof capture.options?.onWritten).toBe('function');

    await capture.options?.onWritten?.({ item: { id: 'm-1', projectId: 'p1', kind: 'FACT' } as MemoryItem, superseded: null });

    expect(record).toHaveBeenCalledTimes(1);
    expect(record).toHaveBeenCalledWith({
      key: 'system.memory.extract-from-event',
      resourceType: 'memory-item',
      resourceId: 'm-1',
      projectId: 'p1',
      summary: 'created FACT',
    });
  });

  it('US-003: the agent_event handler records the same key, as SYSTEM/memory', async () => {
    const { registry, capture } = subscriber();

    await runAsSystem('outbox', async () => {
      await registry.publish(outboxRecord('agent_event', {
        type: 'agent_event', id: 'e2', agentId: 'a2', projectId: 'p1', actorId: 'a1',
        action: 'decision_made', data: { decision: 'use postgres' }, timestamp: new Date().toISOString(),
      }));
    });

    expect(capture.context?.actor).toEqual({ type: 'SYSTEM', id: 'memory' });
    expect(typeof capture.options?.onWritten).toBe('function');
  });

  /** The nesting inherits the outbox record's correlation id, so an entry joins the rest of that delivery. */
  it('US-003: the extraction keeps the enclosing outbox correlation id', async () => {
    const { registry, capture } = subscriber();

    await runAsSystem('outbox', async () => {
      await registry.publish({ ...ticketEvent('e1'), id: 'outbox-7' });
    }, { correlationId: 'corr-7' });

    expect(capture.context?.actor).toEqual({ type: 'SYSTEM', id: 'memory' });
    expect(capture.context?.correlationId).toBe('corr-7');
  });
});
