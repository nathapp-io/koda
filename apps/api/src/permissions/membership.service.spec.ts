import { ForbiddenAppException, NotFoundAppException } from '@nathapp/nestjs-common';
import { PermissionCache } from './permission-cache';
import { MembershipService } from './membership.service';
import type { Granter } from './permissions.types';
import { FakeCacheManager, InMemoryPermissionStore } from './test-helpers/in-memory-permissions';

/**
 * US-003 — MembershipService rules without a database: idempotent create, owner lock and last-owner
 * protection, legacy User.role mirroring with token revocation, cache invalidation. The integration
 * spec runs the concurrency criteria against Postgres.
 */

const BY: Granter = { type: 'SYSTEM', id: 'test' };
const USER = (id: string) => ({ type: 'USER' as const, id });

describe('MembershipService', () => {
  let store: InMemoryPermissionStore;
  let cache: FakeCacheManager;
  let permissionCache: PermissionCache;
  let txRuns: number;
  let service: MembershipService;

  beforeEach(() => {
    store = new InMemoryPermissionStore();
    cache = new FakeCacheManager();
    permissionCache = new PermissionCache(cache as never);
    txRuns = 0;
    // Transactions run one at a time, as the owner-row lock makes concurrent owner writes do in Postgres.
    let queue: Promise<unknown> = Promise.resolve();
    const txManager = {
      run: <T>(fn: () => Promise<T>): Promise<T> => {
        txRuns += 1;
        const result = queue.then(fn);
        queue = result.catch(() => undefined);
        return result;
      },
    };
    service = new MembershipService(
      store.roleRepo() as never,
      store.bindingRepo() as never,
      txManager as never,
      permissionCache,
      cache as never,
    );
    store.addUser('u1');
    store.addUser('u2');
    store.agents.add('a1');
    store.projects.add('p1');
  });

  describe('createBinding', () => {
    it('creates a binding and returns the view with the role key', async () => {
      const view = await service.createBinding(
        { principal: USER('u1'), roleKey: 'developer', projectId: 'p1' },
        BY,
      );
      expect(view).toMatchObject({
        principalType: 'USER', principalId: 'u1', roleKey: 'developer', projectId: 'p1',
        grantedByType: 'SYSTEM', grantedById: 'test',
      });
      expect(store.bindings).toHaveLength(1);
    });

    it('is idempotent: an identical binding is returned, not duplicated', async () => {
      const input = { principal: USER('u1'), roleKey: 'member', projectId: null };
      const first = await service.createBinding(input, BY);
      const second = await service.createBinding(input, BY);
      expect(second.id).toBe(first.id);
      expect(store.bindings).toHaveLength(1);
    });

    it('AC-16/17 (unit): losing the unique index race re-reads and returns the winner', async () => {
      const role = store.roleByKey('member');
      let winnerId = '';
      store.beforeInsert = () => {
        winnerId = store.bind(USER('u1'), 'member', null).id;
      };
      const view = await service.createBinding({ principal: USER('u1'), roleKey: 'member', projectId: null }, BY);
      expect(view.id).toBe(winnerId);
      expect(view.roleId).toBe(role.id);
      expect(store.bindings).toHaveLength(1);
    });

    it('rethrows an error that is not a unique violation', async () => {
      const bindings = store.bindingRepo();
      bindings.createBinding = async () => {
        throw new Error('db down');
      };
      const broken = new MembershipService(
        store.roleRepo() as never, bindings as never,
        { run: (fn: () => Promise<unknown>) => fn() } as never, permissionCache, cache as never,
      );
      await expect(
        broken.createBinding({ principal: USER('u1'), roleKey: 'member', projectId: null }, BY),
      ).rejects.toThrow('db down');
    });

    it('rejects an unknown role key with 404 permissions.roleNotFound', async () => {
      await expect(
        service.createBinding({ principal: USER('u1'), roleKey: 'nope', projectId: null }, BY),
      ).rejects.toBeInstanceOf(NotFoundAppException);
    });

    it('rejects an unknown principal or project', async () => {
      await expect(
        service.createBinding({ principal: USER('ghost'), roleKey: 'member', projectId: null }, BY),
      ).rejects.toBeInstanceOf(NotFoundAppException);
      await expect(
        service.createBinding({ principal: USER('u1'), roleKey: 'developer', projectId: 'ghost' }, BY),
      ).rejects.toBeInstanceOf(NotFoundAppException);
    });

    it('locks the owner role row before changing an owner binding, inside a transaction', async () => {
      await service.createBinding({ principal: USER('u1'), roleKey: 'owner', projectId: null }, BY);
      expect(store.calls).toContain('lock-owner');
      expect(txRuns).toBeGreaterThan(0);
      store.calls.length = 0;
      await service.createBinding({ principal: USER('u2'), roleKey: 'member', projectId: null }, BY);
      expect(store.calls).not.toContain('lock-owner');
    });

    it('AC-18/19: a global admin binding sets User.role ADMIN and bumps the token version', async () => {
      await service.createBinding({ principal: USER('u1'), roleKey: 'admin', projectId: null }, BY);
      expect(store.users.get('u1')).toMatchObject({ role: 'ADMIN', tokenVersion: 1 });
      expect(await service.isGlobalAdmin('u1')).toBe(true);
      expect(cache.invalidations).toEqual(
        expect.arrayContaining(['USER:u1#tag', 'user-auth-state|u1', 'permissions#tag']),
      );
    });

    it('does not touch User.role for a project binding, an agent or another global role', async () => {
      await service.createBinding({ principal: USER('u1'), roleKey: 'developer', projectId: 'p1' }, BY);
      await service.createBinding({ principal: USER('u1'), roleKey: 'member', projectId: null }, BY);
      await service.createBinding({ principal: { type: 'AGENT', id: 'a1' }, roleKey: 'agent', projectId: null }, BY);
      expect(store.users.get('u1')).toMatchObject({ role: 'MEMBER', tokenVersion: 0 });
    });

    it('does not bump the token version when the user is already ADMIN', async () => {
      store.addUser('root', 'ADMIN');
      store.addUser('root2', 'ADMIN');
      await service.createBinding({ principal: USER('root'), roleKey: 'owner', projectId: null }, BY);
      expect(store.users.get('root')?.tokenVersion).toBe(0);
      expect(cache.invalidations).not.toContain('USER:root#tag');
    });

    it('invalidates the permissions cache so the next decision sees the new binding', async () => {
      const service2 = new (await import('./permission.service')).PermissionService(
        store.roleRepo() as never, store.bindingRepo() as never, permissionCache,
      );
      const key = { type: 'USER' as const, id: 'u1' };
      expect((await service2.effectiveKeys(key, { projectId: 'p1' })).has('ticket.create')).toBe(false);
      await service.createBinding({ principal: key, roleKey: 'developer', projectId: 'p1' }, BY);
      expect((await service2.effectiveKeys(key, { projectId: 'p1' })).has('ticket.create')).toBe(true);
    });
  });

  describe('removeBinding', () => {
    it('AC-15: removes the binding and invalidates the permissions cache', async () => {
      const view = await service.createBinding({ principal: USER('u1'), roleKey: 'developer', projectId: 'p1' }, BY);
      await service.removeBinding(view.id);
      expect(store.bindings).toHaveLength(0);
      expect(cache.invalidations).toContain('permissions#tag');
    });

    it('answers 404 for an unknown binding id', async () => {
      await expect(service.removeBinding('missing')).rejects.toBeInstanceOf(NotFoundAppException);
    });

    it('AC-20/21: removing the only global admin binding demotes the user and revokes tokens', async () => {
      const view = await service.createBinding({ principal: USER('u1'), roleKey: 'admin', projectId: null }, BY);
      cache.invalidations.length = 0;
      await service.removeBinding(view.id);
      expect(store.users.get('u1')).toMatchObject({ role: 'MEMBER', tokenVersion: 2 });
      expect(await service.isGlobalAdmin('u1')).toBe(false);
      expect(cache.invalidations).toEqual(expect.arrayContaining(['USER:u1#tag', 'user-auth-state|u1']));
    });

    it('keeps ADMIN while another owner or admin binding remains', async () => {
      const admin = await service.createBinding({ principal: USER('u1'), roleKey: 'admin', projectId: null }, BY);
      await service.createBinding({ principal: USER('u1'), roleKey: 'owner', projectId: null }, BY);
      await service.removeBinding(admin.id);
      expect(store.users.get('u1')?.role).toBe('ADMIN');
    });

    it('AC-22/23: refuses to remove the last enabled owner binding with permissions.ownerLocked', async () => {
      const view = await service.createBinding({ principal: USER('u1'), roleKey: 'owner', projectId: null }, BY);
      const error = await service.removeBinding(view.id).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ForbiddenAppException);
      expect(JSON.stringify(error)).toContain('permissions.ownerLocked');
      expect(store.bindings).toHaveLength(1);
      expect(store.calls).toContain('lock-owner');
    });

    it('counts only owners that are not disabled', async () => {
      store.addUser('off', 'ADMIN', true);
      const live = await service.createBinding({ principal: USER('u1'), roleKey: 'owner', projectId: null }, BY);
      await service.createBinding({ principal: USER('off'), roleKey: 'owner', projectId: null }, BY);
      await expect(service.removeBinding(live.id)).rejects.toBeInstanceOf(ForbiddenAppException);
    });

    it('allows removing an owner binding while another enabled owner remains', async () => {
      const first = await service.createBinding({ principal: USER('u1'), roleKey: 'owner', projectId: null }, BY);
      await service.createBinding({ principal: USER('u2'), roleKey: 'owner', projectId: null }, BY);
      await service.removeBinding(first.id);
      expect(store.bindings.filter((b) => b.roleId === store.roleByKey('owner').id)).toHaveLength(1);
    });

    it('AC-24/25 (unit): two removals in sequence leave one owner and reject the second', async () => {
      const a = await service.createBinding({ principal: USER('u1'), roleKey: 'owner', projectId: null }, BY);
      const b = await service.createBinding({ principal: USER('u2'), roleKey: 'owner', projectId: null }, BY);
      const results = await Promise.allSettled([service.removeBinding(a.id), service.removeBinding(b.id)]);
      expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
      expect(store.bindings).toHaveLength(1);
    });
  });

  describe('setGlobalAdmin', () => {
    it('true grants the admin role through createBinding with the supplied granter', async () => {
      await service.setGlobalAdmin('u1', true, { type: 'USER', id: 'boss' });
      expect(store.bindings[0]).toMatchObject({ grantedByType: 'USER', grantedById: 'boss' });
      expect(store.users.get('u1')?.role).toBe('ADMIN');
    });

    it('false removes only the admin binding and never an owner binding', async () => {
      await service.createBinding({ principal: USER('u1'), roleKey: 'owner', projectId: null }, BY);
      await service.createBinding({ principal: USER('u1'), roleKey: 'admin', projectId: null }, BY);
      await service.setGlobalAdmin('u1', false, BY);
      expect(store.bindings.map((b) => b.roleId)).toEqual([store.roleByKey('owner').id]);
      expect(store.users.get('u1')?.role).toBe('ADMIN');
    });

    it('false demotes a legacy admin who held no binding at all, revoking tokens', async () => {
      store.addUser('legacy', 'ADMIN');
      await service.setGlobalAdmin('legacy', false, BY);
      expect(store.users.get('legacy')).toMatchObject({ role: 'MEMBER', tokenVersion: 1 });
      expect(cache.invalidations).toEqual(expect.arrayContaining(['USER:legacy#tag', 'user-auth-state|legacy']));
    });

    it('false for a member without a binding writes nothing', async () => {
      await service.setGlobalAdmin('u1', false, BY);
      expect(store.users.get('u1')).toMatchObject({ role: 'MEMBER', tokenVersion: 0 });
    });

    it('false for an unknown user is 404', async () => {
      await expect(service.setGlobalAdmin('ghost', false, BY)).rejects.toBeInstanceOf(NotFoundAppException);
    });
  });

  describe('isGlobalAdmin', () => {
    it('is the union of an owner or admin binding and legacy User.role ADMIN', async () => {
      expect(await service.isGlobalAdmin('u1')).toBe(false);
      store.addUser('legacy', 'ADMIN');
      expect(await service.isGlobalAdmin('legacy')).toBe(true);
      store.bind(USER('u2'), 'owner', null);
      expect(await service.isGlobalAdmin('u2')).toBe(true);
    });

    it('a project-scoped admin-looking binding does not count', async () => {
      store.bind(USER('u1'), 'project-admin', 'p1');
      expect(await service.isGlobalAdmin('u1')).toBe(false);
    });
  });

  describe('bindOwnerIfFirst and bindBaseline', () => {
    it('binds owner only for the first user', async () => {
      await service.bindOwnerIfFirst('u1', false);
      expect(store.bindings).toHaveLength(0);
      await service.bindOwnerIfFirst('u1', true);
      expect(store.bindings).toHaveLength(1);
      expect(store.bindings[0]?.roleId).toBe(store.roleByKey('owner').id);
    });

    it('binds member for a USER and agent for an AGENT, globally and idempotently', async () => {
      await service.bindBaseline(USER('u1'));
      await service.bindBaseline(USER('u1'));
      await service.bindBaseline({ type: 'AGENT', id: 'a1' });
      expect(store.bindings.map((b) => [b.principalType, b.roleId, b.projectId])).toEqual([
        ['USER', store.roleByKey('member').id, null],
        ['AGENT', store.roleByKey('agent').id, null],
      ]);
    });
  });

  describe('reads', () => {
    it('findBinding returns the view or null', async () => {
      const view = await service.createBinding({ principal: USER('u1'), roleKey: 'member', projectId: null }, BY);
      expect(await service.findBinding(view.id)).toEqual(view);
      expect(await service.findBinding('missing')).toBeNull();
    });

    it('listBindings filters and paginates, defaulting to 50 and capping at 200', async () => {
      await service.createBinding({ principal: USER('u1'), roleKey: 'member', projectId: null }, BY);
      await service.createBinding({ principal: USER('u2'), roleKey: 'member', projectId: null }, BY);
      const page = await service.listBindings({ principal: USER('u1') }, { current: 1, size: 0 });
      expect(page.records).toHaveLength(1);
      expect(store.calls).toContain('page:1:50');
      await service.listBindings({}, { current: 1, size: 5000 });
      expect(store.calls).toContain('page:1:200');
      await service.listBindings({}, { current: -3, size: 10 });
      expect(store.calls).toContain('page:1:10');
    });
  });

  describe('removeAllBindings', () => {
    it('removes every binding of the principal and demotes a user left without a global admin binding', async () => {
      await service.createBinding({ principal: USER('u2'), roleKey: 'owner', projectId: null }, BY);
      await service.createBinding({ principal: USER('u1'), roleKey: 'admin', projectId: null }, BY);
      await service.createBinding({ principal: USER('u1'), roleKey: 'developer', projectId: 'p1' }, BY);
      await service.removeAllBindings(USER('u1'));
      expect(store.bindings.filter((b) => b.principalId === 'u1')).toHaveLength(0);
      expect(store.users.get('u1')?.role).toBe('MEMBER');
    });

    it('refuses to remove the last enabled owner binding', async () => {
      await service.createBinding({ principal: USER('u1'), roleKey: 'owner', projectId: null }, BY);
      await expect(service.removeAllBindings(USER('u1'))).rejects.toBeInstanceOf(ForbiddenAppException);
      expect(store.bindings).toHaveLength(1);
    });

    it('removes an agent principal bindings without touching users', async () => {
      await service.bindBaseline({ type: 'AGENT', id: 'a1' });
      await service.removeAllBindings({ type: 'AGENT', id: 'a1' });
      expect(store.bindings).toHaveLength(0);
    });
  });
});
