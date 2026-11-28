import { EntityStore } from './entity-store';
import { EntityStoreWarmup } from './rag.module';

const ticket = (id: string, label = id) => ({
  id,
  label,
  tags: label.toLowerCase().split(/\s+/),
  source: 'ticket',
  sourceId: id,
});

describe('EntityStore ticket deletion', () => {
  it('AC-1 removes the indexed ticket from search', () => {
    const store = new EntityStore();
    store.indexEntity('p1', { id: 't1', label: 'Login bug', tags: ['login', 'bug'], source: 'ticket', sourceId: 't1' });

    store.removeEntity('p1', 't1');

    expect(store.searchEntities('p1', 'login')).toEqual([]);
  });

  it('AC-2 tolerates removing an entity that is absent', () => {
    const store = new EntityStore();

    expect(() => store.removeEntity('p1', 'missing')).not.toThrow();
  });

  it('AC-3 removes an entity only from the requested project', () => {
    const store = new EntityStore();
    store.indexEntity('p1', ticket('t1', 'Login bug'));
    store.indexEntity('p2', ticket('t1', 'Login bug'));

    store.removeEntity('p1', 't1');

    expect(store.getAllEntities('p2').map(entity => entity.id)).toEqual(['t1']);
  });

  it('AC-4 handles TICKET_DELETED by removing the ticket from its project', async () => {
    const store = new EntityStore();
    store.indexEntity('p1', ticket('t1'));
    store.indexEntity('p1', ticket('t2'));

    await store.handleOutboxEvent({
      eventType: 'ticket_event',
      payload: { action: 'TICKET_DELETED', ticketId: 't1', projectId: 'p1' },
    });

    expect(store.getAllEntities('p1').map(entity => entity.id)).toEqual(['t2']);
  });

  it('AC-5 does not reread a deleted ticket', async () => {
    const repository = { findTicketById: vi.fn() };
    const store = new EntityStore(repository as never);
    store.indexEntity('p1', ticket('t1'));

    await store.handleOutboxEvent({
      eventType: 'ticket_event',
      payload: { action: 'TICKET_DELETED', ticketId: 't1', projectId: 'p1' },
    });

    expect(repository.findTicketById).not.toHaveBeenCalled();
  });

  it('AC-6 leaves ordinary TICKET_UPDATED events on the reindex path', async () => {
    const repository = { findTicketById: vi.fn().mockResolvedValue({ id: 't3', title: 'Export report' }) };
    const store = new EntityStore(repository as never);

    await store.handleOutboxEvent({
      eventType: 'ticket_event',
      payload: { action: 'TICKET_UPDATED', ticketId: 't3', projectId: 'p1' },
    });

    expect(store.searchEntities('p1', 'export').map(entity => entity.id)).toEqual(['t3']);
    expect(repository.findTicketById).toHaveBeenCalledWith('t3');
  });

  it('AC-7 routes deletion through the registered ticket_event fan-out handler', async () => {
    const store = new EntityStore();
    store.indexEntity('p1', { id: 't1', label: 'Login bug', tags: ['login', 'bug'], source: 'ticket', sourceId: 't1' });
    const handlers = new Map<string, (payload: unknown) => Promise<void>>();
    const publisher = { register: vi.fn((eventType: string, handler: (payload: unknown) => Promise<void>) => {
      handlers.set(eventType, handler);
    }) };
    const warmup = new EntityStoreWarmup(store, publisher as never);

    await warmup.onModuleInit();
    await handlers.get('ticket_event')?.({ action: 'TICKET_DELETED', ticketId: 't1', projectId: 'p1' });

    expect(store.searchEntities('p1', 'login')).toEqual([]);
  });

  it('AC-8 treats deletion of an unknown ticket as an idempotent no-op', async () => {
    const repository = { findTicketById: vi.fn().mockResolvedValue({ id: 'unknown', title: 'Deleted ticket' }) };
    const store = new EntityStore(repository as never);
    store.indexEntity('p1', ticket('t2'));

    await expect(store.handleOutboxEvent({
      eventType: 'ticket_event',
      payload: { action: 'TICKET_DELETED', ticketId: 'unknown', projectId: 'p1' },
    })).resolves.toBeUndefined();

    expect(repository.findTicketById).not.toHaveBeenCalled();
    expect(store.getAllEntities('p1').map(entity => entity.id)).toEqual(['t2']);
  });

  /**
   * Review B2: the outbox re-delivers a whole event after a handler failure, so an update queued before the deletion
   * can be handled after it. The repository excludes soft-deleted tickets, so that retry answers nothing to index.
   */
  it('B2: a retried update after the deletion adds no entity back', async () => {
    const repository = { findTicketById: vi.fn().mockResolvedValue(null) };
    const store = new EntityStore(repository as never);
    store.indexEntity('p1', ticket('t1', 'Login bug'));

    await store.handleOutboxEvent({
      eventType: 'ticket_event',
      payload: { action: 'TICKET_DELETED', ticketId: 't1', projectId: 'p1' },
    });
    await store.handleOutboxEvent({
      eventType: 'ticket_event',
      payload: { action: 'TICKET_UPDATED', ticketId: 't1', projectId: 'p1' },
    });

    expect(repository.findTicketById).toHaveBeenCalledWith('t1');
    expect(store.getAllEntities('p1')).toEqual([]);
  });

  /** Review B2: a reread already in flight when the deletion lands must not put the row it read back. */
  it('B2: a reread that answers after the deletion is discarded', async () => {
    let answer: (ticket: { id: string; title: string }) => void = () => undefined;
    const repository = {
      findTicketById: vi.fn(() => new Promise<{ id: string; title: string }>((resolve) => { answer = resolve; })),
    };
    const store = new EntityStore(repository as never);
    store.indexEntity('p1', ticket('t1', 'Login bug'));

    const update = store.handleOutboxEvent({
      eventType: 'ticket_event',
      payload: { action: 'TICKET_UPDATED', ticketId: 't1', projectId: 'p1' },
    });
    await store.handleOutboxEvent({
      eventType: 'ticket_event',
      payload: { action: 'TICKET_DELETED', ticketId: 't1', projectId: 'p1' },
    });
    expect(store.getAllEntities('p1')).toEqual([]);

    answer({ id: 't1', title: 'Login bug' });
    await update;

    expect(store.getAllEntities('p1')).toEqual([]);
  });

  /** Review B2: the fence is per project, so a deletion in one project does not drop another project's reread. */
  it('B2: a deletion in one project does not discard the same ticket id in another', async () => {
    const repository = { findTicketById: vi.fn().mockResolvedValue({ id: 't1', title: 'Login bug' }) };
    const store = new EntityStore(repository as never);

    const reread = store.handleOutboxEvent({
      eventType: 'ticket_event',
      payload: { action: 'TICKET_UPDATED', ticketId: 't1', projectId: 'p2' },
    });
    store.removeEntity('p1', 't1');
    await reread;

    expect(store.getAllEntities('p2').map(entity => entity.id)).toEqual(['t1']);
  });
});
