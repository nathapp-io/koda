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

describe('EntityStore graph refresh', () => {
  it('replaces the module snapshot, preserves a ticket with the same ID, and ignores old event nodes', async () => {
    const repository = {
      scanCodeModules: vi.fn(async (_projectId: string, consume: (page: Array<{ nodeId: string; label: string }>) => void) => {
        consume([{ nodeId: 'shared-id', label: 'NewModule' }]);
      }),
    };
    const store = new EntityStore(repository as never);
    store.indexEntity('project', { id: 'shared-id', label: 'Ticket', tags: [], source: 'ticket', sourceId: 'shared-id' });
    store.indexEntity('project', { id: 'old', label: 'OldModule', tags: [], source: 'code_module', sourceId: 'old' });
    await store.handleOutboxEvent({
      eventType: 'graphify_import',
      payload: { projectId: 'project', nodes: [{ id: 'old', label: 'OldModule', type: 'code_module' }] },
    });
    expect(store.getAllEntities('project').map(entity => entity.label).sort()).toEqual(['NewModule', 'Ticket']);
    repository.scanCodeModules.mockResolvedValue(undefined);
    await store.handleOutboxEvent({ eventType: 'graphify_import', payload: { projectId: 'project' } });
    expect(store.getAllEntities('project').map(entity => entity.label)).toEqual(['Ticket']);
  });

  it('does not publish a refresh queued before the project was cleared', async () => {
    let started!: () => void;
    let finish!: () => void;
    const scanning = new Promise<void>(resolve => { started = resolve; });
    const finishScan = new Promise<void>(resolve => { finish = resolve; });
    const repository = {
      scanCodeModules: vi.fn(async (_projectId: string, consume: (page: Array<{ nodeId: string; label: string }>) => void) => {
        started();
        await finishScan;
        consume([{ nodeId: 'old', label: 'OldModule' }]);
      }),
    };
    const store = new EntityStore(repository as never);
    const active = store.indexGraphifyEntitiesForProject('project');
    await scanning;
    const queued = store.indexGraphifyEntitiesForProject('project');
    store.clear('project');
    finish();
    await Promise.all([active, queued]);
    expect(store.searchEntities('project', 'OldModule')).toEqual([]);
    expect(repository.scanCodeModules).toHaveBeenCalledTimes(1);
  });

  it('keeps the previous snapshot on a page failure and allows an event retry', async () => {
    const repository = {
      scanCodeModules: vi.fn(async (_projectId: string, consume: (page: Array<{ nodeId: string; label: string }>) => void): Promise<void> => {
        consume([{ nodeId: 'new', label: 'NewModule' }]);
        throw new Error('page failed');
      }),
    };
    const store = new EntityStore(repository as never);
    store.indexEntity('project', { id: 'old', label: 'OldModule', tags: [], source: 'code_module', sourceId: 'old' });
    await expect(store.indexGraphifyEntitiesForProject('project')).rejects.toThrow('page failed');
    expect(store.getAllEntities('project').map(entity => entity.label)).toEqual(['OldModule']);
    repository.scanCodeModules.mockImplementation(async (_projectId, consume) => {
      consume([{ nodeId: 'new', label: 'NewModule' }]);
    });
    await store.indexGraphifyEntitiesForProject('project');
    expect(store.getAllEntities('project').map(entity => entity.label)).toEqual(['NewModule']);
  });
});
