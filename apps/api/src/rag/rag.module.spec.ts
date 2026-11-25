import { EntityStoreWarmup } from './rag.module';

describe('EntityStoreWarmup', () => {
  it('continues through the current and following project pages after a project scan fails', async () => {
    const store = {
      indexGraphifyEntitiesForProject: vi.fn().mockRejectedValueOnce(new Error('scan timed out')),
    };
    const repository = {
      findActiveProjectIdsPage: vi.fn()
        .mockResolvedValueOnce([{ id: 'a' }, { id: 'b' }])
        .mockResolvedValueOnce([{ id: 'c' }])
        .mockResolvedValueOnce([]),
    };
    const warmup = new EntityStoreWarmup(store as never, { register: vi.fn() } as never, repository as never);
    await warmup.onModuleInit();
    expect(store.indexGraphifyEntitiesForProject.mock.calls).toEqual([['a'], ['b'], ['c']]);
    expect(repository.findActiveProjectIdsPage.mock.calls).toEqual([[undefined], ['b'], ['c']]);
  });
});
