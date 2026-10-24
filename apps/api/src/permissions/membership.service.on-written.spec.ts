import type { RoleBindingView } from './permissions.types';
import { MembershipService } from './membership.service';
import { AfterCommitService } from './after-commit.service';
import { PermissionCache } from './permission-cache';
import { FakeCacheManager, InMemoryPermissionStore } from './test-helpers/in-memory-permissions';

const input = { principal: { type: 'USER' as const, id: 'u1' }, roleKey: 'developer', projectId: 'p1' };
const by = { type: 'SYSTEM' as const, id: 'test' };

describe('MembershipService onWritten', () => {
  let store: InMemoryPermissionStore;
  let service: MembershipService;
  let inside: boolean;
  beforeEach(() => {
    store = new InMemoryPermissionStore();
    store.addUser('u1');
    store.projects.add('p1');
    const cache = new FakeCacheManager();
    inside = false;
    const tx = {
      isInTransaction: () => inside,
      run: async <T>(fn: () => Promise<T>) => {
        inside = true;
        try { return await fn(); } finally { inside = false; }
      },
    };
    service = new MembershipService(store.roleRepo() as never, store.bindingRepo() as never,
      tx as never, new PermissionCache(cache as never), cache as never, new AfterCommitService());
  });
  it('AC-13: invokes the insert callback exactly once inside the inserting transaction', async () => {
    const callback = vi.fn(async (binding: RoleBindingView) => {
      expect(inside).toBe(true);
      expect(store.bindings.map(row => row.id)).toContain(binding.id);
    });
    const view = await service.createBinding(input, by, callback);
    expect(callback).toHaveBeenCalledExactlyOnceWith(view);
  });
  it('AC-14/15: returns the existing view without callback', async () => {
    const first = await service.createBinding(input, by);
    const callback = vi.fn();
    expect(await service.createBinding(input, by, callback)).toEqual(first);
    expect(callback).not.toHaveBeenCalled();
  });
  it('AC-16: re-reads a concurrent winner without callback', async () => {
    let winnerId = '';
    store.beforeInsert = () => { winnerId = store.bind(input.principal, input.roleKey, input.projectId).id; };
    const callback = vi.fn();
    expect((await service.createBinding(input, by, callback)).id).toBe(winnerId);
    expect(callback).not.toHaveBeenCalled();
  });
  it('AC-17: invokes the delete callback once inside the deleting transaction', async () => {
    const view = await service.createBinding(input, by);
    const callback = vi.fn(async (binding: RoleBindingView) => {
      expect(inside).toBe(true);
      expect(store.bindings.map(row => row.id)).not.toContain(binding.id);
    });
    await service.removeBinding(view.id, { onWritten: callback });
    expect(callback).toHaveBeenCalledExactlyOnceWith(view);
  });
  it('AC-24: preserves two-argument inserts', async () => {
    expect(await service.createBinding(input, by)).toMatchObject({ roleKey: 'developer', principalId: 'u1' });
  });
  it('AC-25: preserves removal with last-admin override and no callback', async () => {
    const view = await service.createBinding({ ...input, roleKey: 'project-admin' }, by);
    await expect(service.removeBinding(view.id, { lastProjectAdminOverride: true })).resolves.toBeUndefined();
    expect(store.bindings).toHaveLength(0);
  });
});
