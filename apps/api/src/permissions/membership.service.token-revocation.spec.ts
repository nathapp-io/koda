import { createMockPrismaService } from '@nathapp/nestjs-prisma';
import { MembershipService } from './membership.service';
import { PrismaRoleBindingRepository } from './prisma-role-binding.repository';
import { PermissionCache } from './permission-cache';
import { AfterCommitService } from './after-commit.service';
import { userAuthStateCacheKey } from '../auth/token-version.cache';
import { FakeCacheManager, InMemoryPermissionStore } from './test-helpers/in-memory-permissions';

const principal = { type: 'USER' as const, id: 'u1' };
const by = { type: 'SYSTEM' as const, id: 'test' };
describe('binding-derived token revocation', () => {
  let store: InMemoryPermissionStore;
  let cache: FakeCacheManager;
  let service: MembershipService;
  beforeEach(() => {
    store = new InMemoryPermissionStore();
    store.addUser('u1');
    store.projects.add('p1');
    cache = new FakeCacheManager();
    service = new MembershipService(store.roleRepo() as never, store.bindingRepo() as never,
      { run: (fn: () => Promise<unknown>) => fn(), isInTransaction: () => false } as never,
      new PermissionCache(cache as never), cache as never, new AfterCommitService());
  });
  const tokens = () => store.calls.filter(call => call === 'tokens:u1');
  const grant = (roleKey = 'admin', projectId: string | null = null) => service.createBinding({ principal, roleKey, projectId }, by);
  it('AC-1: first global admin grant revokes exactly once', async () => {
    await grant(); expect(tokens()).toEqual(['tokens:u1']);
    expect(store.users.get('u1')?.tokenVersion).toBe(1);
  });
  it('AC-2: existing owner prevents revocation', async () => {
    store.bind(principal, 'owner'); await grant(); expect(tokens()).toEqual([]);
  });
  it.each(['p1', null])('AC-3: PROJECT role at %s never revokes', async projectId => {
    await grant('project-admin', projectId); expect(tokens()).toEqual([]);
  });
  it('AC-4: identical grant does not revoke', async () => {
    store.bind(principal, 'admin'); await grant(); expect(tokens()).toEqual([]);
  });
  it('AC-5: last global admin removal revokes once', async () => {
    await service.removeBinding(store.bind(principal, 'admin').id); expect(tokens()).toEqual(['tokens:u1']);
  });
  it('AC-6: surviving owner prevents revocation', async () => {
    store.bind(principal, 'owner'); await service.removeBinding(store.bind(principal, 'admin').id);
    expect(tokens()).toEqual([]);
  });
  it('AC-7: removeAll revokes once', async () => {
    store.bind(principal, 'admin'); store.bind(principal, 'member');
    await service.removeAllBindings(principal); expect(tokens()).toEqual(['tokens:u1']);
  });
  it('AC-8: invalidates auth state after promotion', async () => {
    const invalidate = vi.spyOn(cache, 'invalidate'); await grant();
    expect(invalidate).toHaveBeenCalledWith(userAuthStateCacheKey('u1'));
  });
  it('AC-12: bump failure propagates without cache invalidation', async () => {
    const error = new Error('bump failed'); store.bumpTokenVersionFailure = error;
    await expect(grant()).rejects.toBe(error); expect(cache.invalidations).toEqual([]);
  });
  it('AC-15: removing absent admin does not revoke', async () => {
    await service.setGlobalAdmin('u1', false, by); expect(tokens()).toEqual([]);
  });
  it('missing user at bump does not invalidate auth state', async () => {
    store.beforeInsert = () => { store.users.delete('u1'); };
    await grant(); expect(tokens()).toEqual([]);
    expect(cache.invalidations).not.toContain('user-auth-state|u1');
  });
});

describe('token version repository', () => {
  it.each([null, { disabled: true }])('selects only account state: %s', async state => {
    const prisma = createMockPrismaService({ fn: vi.fn });
    const findUnique = vi.fn().mockResolvedValue(state);
    Object.assign(prisma.client, { user: { findUnique } });
    const repo = new PrismaRoleBindingRepository({} as never, prisma as never);
    expect(await repo.findUserState('u1')).toEqual(state);
    expect(findUnique).toHaveBeenCalledExactlyOnceWith({ where: { id: 'u1' }, select: { disabled: true } });
  });
  it.each([1, 0])('AC-13/14: unconditional increment, count %s', async count => {
    const prisma = createMockPrismaService({ fn: vi.fn });
    const updateMany = vi.fn().mockResolvedValue({ count });
    Object.assign(prisma.client, { user: { updateMany } });
    const repo = new PrismaRoleBindingRepository({} as never, prisma as never);
    expect(await repo.bumpTokenVersion('u1')).toBe(count > 0);
    expect(updateMany).toHaveBeenCalledExactlyOnceWith({ where: { id: 'u1' }, data: { tokenVersion: { increment: 1 } } });
  });
});
