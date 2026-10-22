import { ForbiddenAppException, NotFoundAppException } from '@nathapp/nestjs-common';
import type { KodaPrincipal } from '../auth/principal/koda-principal.types';
import { AfterCommitService } from './after-commit.service';
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

/** A transaction manager double that runs the callback immediately, outside any transaction. */
const immediateTx = () => ({
  run: <T>(fn: () => Promise<T>): Promise<T> => fn(),
  isInTransaction: () => false,
});

describe('MembershipService', () => {
  let store: InMemoryPermissionStore;
  let cache: FakeCacheManager;
  let permissionCache: PermissionCache;
  let bindingRepo: ReturnType<InMemoryPermissionStore['bindingRepo']>;
  let txRuns: number;
  let service: MembershipService;

  beforeEach(() => {
    store = new InMemoryPermissionStore();
    cache = new FakeCacheManager();
    permissionCache = new PermissionCache(cache as never);
    bindingRepo = store.bindingRepo();
    txRuns = 0;
    // Transactions run one at a time, as the owner-row lock makes concurrent owner writes do in Postgres.
    let queue: Promise<unknown> = Promise.resolve();
    // Nesting is tracked so `isInTransaction()` answers like the real manager's AsyncLocalStorage: a
    // `run` that joins an open transaction leaves the store in place for its caller.
    let depth = 0;
    const txManager = {
      isInTransaction: () => depth > 0,
      run: <T>(fn: () => Promise<T>): Promise<T> => {
        txRuns += 1;
        depth += 1;
        const result = queue.then(fn);
        queue = result.catch(() => undefined);
        return result.finally(() => {
          depth -= 1;
        });
      },
    };
    service = new MembershipService(
      store.roleRepo() as never,
      bindingRepo as never,
      txManager as never,
      permissionCache,
      cache as never,
      new AfterCommitService(),
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
        immediateTx() as never, permissionCache, cache as never, new AfterCommitService(),
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
        store.roleRepo() as never,
        store.bindingRepo() as never,
        permissionCache,
        { agentProjectScoping: true } as never,
      );
      const key = { type: 'USER' as const, id: 'u1' };
      expect((await service2.effectiveKeys(key, { projectId: 'p1' })).has('ticket.create')).toBe(false);
      await service.createBinding({ principal: key, roleKey: 'developer', projectId: 'p1' }, BY);
      expect((await service2.effectiveKeys(key, { projectId: 'p1' })).has('ticket.create')).toBe(true);
    });
  });

  describe('createBindingForRole (US-005 AC-7)', () => {
    it('binds the role named by its id and returns the view', async () => {
      const role = store.roleByKey('developer');

      const view = await service.createBindingForRole(
        { principal: USER('u1'), roleId: role.id, projectId: 'p1' },
        BY,
      );

      expect(view).toMatchObject({
        principalType: 'USER', principalId: 'u1', roleId: role.id, roleKey: 'developer', projectId: 'p1',
      });
      expect(store.bindings).toHaveLength(1);
    });

    it('never rebinds a deleted role key to the role that reused it', async () => {
      const original = store.roleByKey('triager');
      // A concurrent admin deletes the role and creates a broader one under the same key.
      store.roles = store.roles.filter((role) => role.id !== original.id);
      const replacement: typeof original = { ...original, id: 'role-replacement', permissions: ['*'] };
      store.roles.push(replacement);

      // The invite's persisted id is what binds: the key resolution would have granted the replacement.
      expect(await service.createBindingForRole({ principal: USER('u1'), roleId: original.id, projectId: 'p1' }, BY))
        .toBeNull();
      expect(store.bindings).toHaveLength(0);

      await service.createBinding({ principal: USER('u1'), roleKey: 'triager', projectId: 'p1' }, BY);
      expect(store.bindings[0]?.roleId).toBe(replacement.id);
    });

    it('answers null, writing nothing, when the role id is unknown', async () => {
      expect(await service.createBindingForRole({ principal: USER('u1'), roleId: 'ghost', projectId: 'p1' }, BY))
        .toBeNull();
      expect(store.bindings).toHaveLength(0);
      expect(txRuns).toBe(0);
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

    it('M1: answers 404 when another caller deleted the same row first', async () => {
      const view = await service.createBinding(
        { principal: USER('u1'), roleKey: 'admin', projectId: null },
        BY,
      );
      expect(store.users.get('u1')?.role).toBe('ADMIN');
      cache.invalidations.length = 0;

      // The row was read, then a concurrent delete removed it before this transaction's statement:
      // the delete reports zero affected rows, which is the 404 the loser must answer.
      const bindings = store.bindingRepo();
      bindings.deleteById = async () => false;
      const loser = new MembershipService(
        store.roleRepo() as never,
        bindings as never,
        immediateTx() as never,
        permissionCache,
        cache as never,
        new AfterCommitService(),
      );

      const error = await loser.removeBinding(view.id).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(NotFoundAppException);
      expect(JSON.stringify(error)).toContain('permissions.bindingNotFound');
      // Losing the delete changes nothing: no demotion, no token revocation, no cache invalidation.
      expect(store.users.get('u1')?.role).toBe('ADMIN');
      expect(store.users.get('u1')?.tokenVersion).toBe(1);
      expect(cache.invalidations).toEqual([]);
    });

    it('B2: locks the binding\'s user before deciding the legacy role', async () => {
      store.addUser('admin-1', 'ADMIN');
      const binding = await service.createBinding(
        { principal: USER('admin-1'), roleKey: 'admin', projectId: null },
        BY,
      );
      store.calls.length = 0;

      await service.removeBinding(binding.id);

      // The survivor count runs under the user lock, so a concurrent owner/admin removal of the same
      // user is either fully before it or fully after it.
      const lock = store.calls.indexOf('lock-user:admin-1');
      expect(lock).toBeGreaterThanOrEqual(0);
      expect(lock).toBeLessThan(store.calls.indexOf(`delete-binding:${binding.id}`));
    });

    it('B2: takes the owner role lock before the user lock, never the other way round', async () => {
      const binding = await service.createBinding(
        { principal: USER('u1'), roleKey: 'owner', projectId: null },
        BY,
      );
      // A second owner keeps the last-owner rule out of the way.
      await service.createBinding({ principal: USER('u2'), roleKey: 'owner', projectId: null }, BY);
      store.calls.length = 0;

      await service.removeBinding(binding.id);

      expect(store.calls.indexOf('lock-owner')).toBeLessThan(store.calls.indexOf('lock-user:u1'));
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

  describe('removeProjectBindings', () => {
    const roleKeysIn = (projectId: string | null): string[] =>
      store.bindings
        .filter((binding) => binding.projectId === projectId)
        .map((binding) => store.roles.find((role) => role.id === binding.roleId)?.key ?? '?');

    it('AC-13: deletes the given role keys in the project only, and answers the count', async () => {
      store.projects.add('p2');
      await service.createBinding({ principal: USER('u1'), roleKey: 'developer', projectId: 'p1' }, BY);
      await service.createBinding({ principal: USER('u1'), roleKey: 'reviewer', projectId: 'p1' }, BY);
      await service.createBinding({ principal: USER('u1'), roleKey: 'developer', projectId: 'p2' }, BY);
      await service.createBinding({ principal: USER('u2'), roleKey: 'developer', projectId: 'p1' }, BY);

      expect(await service.removeProjectBindings(USER('u1'), 'p1', ['developer'])).toBe(1);

      expect(roleKeysIn('p1')).toEqual(['reviewer', 'developer']);
      expect(roleKeysIn('p2')).toEqual(['developer']);
    });

    it('without role keys it deletes every binding of the principal in the project', async () => {
      await service.createBinding({ principal: USER('u1'), roleKey: 'developer', projectId: 'p1' }, BY);
      await service.createBinding({ principal: USER('u1'), roleKey: 'reviewer', projectId: 'p1' }, BY);
      await service.createBinding({ principal: USER('u1'), roleKey: 'admin', projectId: null }, BY);

      expect(await service.removeProjectBindings(USER('u1'), 'p1')).toBe(2);

      expect(roleKeysIn('p1')).toEqual([]);
      expect(roleKeysIn(null)).toEqual(['admin']);
    });

    it('never touches a projectId-null binding, another project or another principal', async () => {
      store.projects.add('p2');
      await service.createBinding({ principal: USER('u1'), roleKey: 'member', projectId: null }, BY);
      await service.createBinding({ principal: USER('u1'), roleKey: 'developer', projectId: 'p2' }, BY);
      await service.createBinding({ principal: USER('u2'), roleKey: 'developer', projectId: 'p1' }, BY);

      expect(await service.removeProjectBindings(USER('u1'), 'p1')).toBe(0);

      expect(store.bindings).toHaveLength(3);
    });

    it('leaves the legacy role mirror and the token version of a global admin alone', async () => {
      await service.createBinding({ principal: USER('u1'), roleKey: 'admin', projectId: null }, BY);
      await service.createBinding({ principal: USER('u1'), roleKey: 'developer', projectId: 'p1' }, BY);
      cache.invalidations.length = 0;

      expect(await service.removeProjectBindings(USER('u1'), 'p1')).toBe(1);

      expect(store.users.get('u1')).toMatchObject({ role: 'ADMIN', tokenVersion: 1 });
      expect(cache.invalidations).not.toContain('USER:u1#tag');
    });

    it('AC-14: invalidates the permission cache so the next decision answers no access', async () => {
      const permissionService = new (await import('./permission.service')).PermissionService(
        store.roleRepo() as never,
        store.bindingRepo() as never,
        permissionCache,
        { agentProjectScoping: true } as never,
      );
      const principal = {
        actorType: 'user',
        id: 'u1',
        role: 'MEMBER',
        email: 'u1@koda.test',
      } as unknown as KodaPrincipal;
      await service.createBinding({ principal: USER('u1'), roleKey: 'developer', projectId: 'p1' }, BY);
      expect((await permissionService.can(principal, 'ticket.create', { projectId: 'p1' })).allowed).toBe(true);

      expect(await service.removeProjectBindings(USER('u1'), 'p1')).toBe(1);

      expect((await permissionService.can(principal, 'ticket.create', { projectId: 'p1' })).allowed).toBe(false);
      expect(cache.invalidations).toContain('permissions#tag');
    });

    it('invalidates the cache even when no binding was removed, because the caller deletes the legacy row next', async () => {
      cache.invalidations.length = 0;

      expect(await service.removeProjectBindings(USER('u1'), 'p1')).toBe(0);

      expect(cache.invalidations).toContain('permissions#tag');
    });

    it('B2: a legacy-only removal leaves the next decision without access', async () => {
      // A member whose only source in the project is a legacy `ProjectMember` row: `removeProjectBindings`
      // deletes nothing, and the caller's legacy delete is what ends their access.
      let legacy: string[] = ['developer'];
      bindingRepo.findLegacyRoleKeys = async () => legacy;
      const permissionService = new (await import('./permission.service')).PermissionService(
        store.roleRepo() as never,
        bindingRepo as never,
        permissionCache,
        { agentProjectScoping: true } as never,
      );
      const principal = {
        actorType: 'user',
        id: 'u1',
        role: 'MEMBER',
        email: 'u1@koda.test',
      } as unknown as KodaPrincipal;
      expect((await permissionService.can(principal, 'ticket.create', { projectId: 'p1' })).allowed).toBe(true);

      // The caller's transaction: the binding delete (nothing), then the legacy row goes away.
      await service.afterCommit(async () => {
        expect(await service.removeProjectBindings(USER('u1'), 'p1')).toBe(0);
        legacy = [];
        expect(cache.invalidations).toEqual([]);
      });

      expect(cache.invalidations).toContain('permissions#tag');
      expect((await permissionService.can(principal, 'ticket.create', { projectId: 'p1' })).allowed).toBe(false);
    });

    it('locks the user row and runs inside a transaction', async () => {
      await service.createBinding({ principal: USER('u1'), roleKey: 'developer', projectId: 'p1' }, BY);
      store.calls.length = 0;
      txRuns = 0;

      await service.removeProjectBindings(USER('u1'), 'p1');

      expect(txRuns).toBeGreaterThan(0);
      expect(store.calls.indexOf('lock-user:u1')).toBeLessThan(
        store.calls.indexOf('delete-project-bindings:USER:u1:p1'),
      );
    });

    it('defers the invalidation to the end of the transaction that owns the removal', async () => {
      await service.createBinding({ principal: USER('u1'), roleKey: 'developer', projectId: 'p1' }, BY);
      cache.invalidations.length = 0;

      await service.afterCommit(async () => {
        expect(await service.removeProjectBindings(USER('u1'), 'p1')).toBe(1);
        expect(cache.invalidations).toEqual([]);
      });

      expect(cache.invalidations).toContain('permissions#tag');
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
    /**
     * Installs the B2 barrier on the service's repository: a concurrent grant that commits before the
     * removal takes its first lock. The hook covers both the first lock and the first read, so the grant
     * lands in the same window whichever order the removal uses — the unlocked-read shape the finding is
     * about, or the locked one — and `restore()` puts the repository back afterwards.
     */
    const grantBeforeTheFirstLock = (grant: () => void): (() => void) => {
      const originalLock = bindingRepo.lockOwnerRole.bind(bindingRepo);
      const originalRead = bindingRepo.findPrincipalBindings.bind(bindingRepo);
      let granted = false;
      const grantOnce = () => {
        if (granted) return;
        granted = true;
        grant();
      };
      bindingRepo.lockOwnerRole = async () => {
        grantOnce();
        return originalLock();
      };
      bindingRepo.findPrincipalBindings = async (principal) => {
        const rows = await originalRead(principal);
        grantOnce();
        store.calls.push('read-bindings');
        return rows;
      };
      return () => {
        bindingRepo.lockOwnerRole = originalLock;
        bindingRepo.findPrincipalBindings = originalRead;
      };
    };

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

    it('B2: locks the user row before the survivor count of removeAllBindings', async () => {
      await service.createBinding({ principal: USER('u1'), roleKey: 'owner', projectId: null }, BY);
      await service.createBinding({ principal: USER('u2'), roleKey: 'owner', projectId: null }, BY);
      await service.createBinding({ principal: USER('u1'), roleKey: 'admin', projectId: null }, BY);
      store.calls.length = 0;

      await service.removeAllBindings(USER('u1'));

      expect(store.calls.indexOf('lock-user:u1')).toBeGreaterThanOrEqual(0);
      expect(store.calls.indexOf('lock-owner')).toBeLessThan(store.calls.indexOf('lock-user:u1'));
    });

    it('B2: a grant committed before the bulk-removal lock is deleted and demotes the user', async () => {
      // The user holds no owner binding, so a removal that decides its snapshot from an unlocked read
      // would find nothing to lock for and keep its own stale rows. The grant below is the concurrent
      // admin request that commits in that window: it promotes the user and returns.
      await service.bindBaseline(USER('u1'));
      const restore = grantBeforeTheFirstLock(() => {
        store.bind(USER('u1'), 'admin', null);
        store.users.set('u1', { role: 'ADMIN', disabled: false, tokenVersion: 1 });
      });

      try {
        await service.removeAllBindings(USER('u1'));
      } finally {
        restore();
      }

      // The snapshot is read under the locks, so the committed admin binding is part of what is deleted
      // and of the legacy-role mirror: no binding survives and no legacy ADMIN is left behind.
      expect(store.calls.indexOf('lock-user:u1')).toBeLessThan(store.calls.indexOf('read-bindings'));
      expect(store.bindings.filter((b) => b.principalId === 'u1')).toHaveLength(0);
      expect(store.users.get('u1')).toMatchObject({ role: 'MEMBER', tokenVersion: 2 });
      expect(cache.invalidations).toEqual(expect.arrayContaining(['USER:u1#tag', 'user-auth-state|u1']));
    });

    it('B2: an owner grant committed before the bulk-removal lock still protects the last owner', async () => {
      // The same window, an owner binding instead: the removal must see it and refuse, rather than
      // delete the installation's only owner because the read before the lock found none.
      await service.bindBaseline(USER('u1'));
      const restore = grantBeforeTheFirstLock(() => {
        store.bind(USER('u1'), 'owner', null);
      });

      try {
        await expect(service.removeAllBindings(USER('u1'))).rejects.toBeInstanceOf(ForbiddenAppException);
      } finally {
        restore();
      }

      expect(store.bindings.filter((b) => b.roleId === store.roleByKey('owner').id)).toHaveLength(1);
    });
  });

  describe('the commit boundary of a nested write (B3)', () => {
    it('defers the invalidation to the end of the transaction that owns the write', async () => {
      await service.afterCommit(async () => {
        await service.setGlobalAdmin('u1', true, BY);
        // Nothing outside can see the binding yet, so nothing may drop the cache here: a request in
        // this window would recompute the old keys and cache them under the new generation.
        expect(cache.invalidations).toEqual([]);
      });

      expect(cache.invalidations).toContain('permissions#tag');
      expect(cache.invalidations).toEqual(expect.arrayContaining(['USER:u1#tag', 'user-auth-state|u1']));
    });

    it('defers through several nested writes, flushing once at the end', async () => {
      await service.afterCommit(async () => {
        await service.bindBaseline(USER('u1'));
        await service.bindBaseline(USER('u2'));
        expect(cache.invalidations).toEqual([]);
      });

      expect(cache.invalidations).toEqual(['permissions#tag', 'permissions#tag']);
    });

    it('invalidates nothing when the transaction is rolled back', async () => {
      const failure = new Error('rolled back');

      await expect(
        service.afterCommit(async () => {
          await service.setGlobalAdmin('u1', true, BY);
          throw failure;
        }),
      ).rejects.toBe(failure);

      expect(cache.invalidations).toEqual([]);
    });

    it('invalidates immediately when the write owns the transaction', async () => {
      await service.setGlobalAdmin('u1', true, BY);

      expect(cache.invalidations).toContain('permissions#tag');
    });
  });
});
