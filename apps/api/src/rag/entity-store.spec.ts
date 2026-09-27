import { EntityStore } from './entity-store';

describe('EntityStore.handleOutboxEvent', () => {
  it('Slice 5: a COMMENT_ADDED ticket_event is handled without error (re-index only, no comment data used)', async () => {
    const store = new EntityStore();
    await expect(store.handleOutboxEvent({
      eventType: 'ticket_event',
      payload: {
        id: 'evt-comment', type: 'ticket_event', action: 'COMMENT_ADDED', ticketId: 'ticket-1',
        projectId: 'project-123', actorId: 'user-1', data: { commentId: 'comment-1' }, timestamp: new Date().toISOString(),
      },
    })).resolves.toBeUndefined();
    expect(store.searchEntities('project-123', 'comment')).toEqual([]);
  });
});
