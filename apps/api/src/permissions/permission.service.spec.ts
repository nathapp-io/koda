import type { KodaPrincipal } from '../auth/principal/koda-principal.types';
import { PermissionCache } from './permission-cache';
import { PermissionService } from './permission.service';
import { FakeCacheManager, InMemoryPermissionStore } from './test-helpers/in-memory-permissions';

/**
 * US-003 — PermissionService.can rules 1-10 and the cached effective keys, without a database.
 * The integration spec covers the same acceptance criteria against Postgres.
 */

const user = (id: string): KodaPrincipal =>
  ({ actorType: 'user', id, role: 'MEMBER', email: `${id}@x.test` }) as KodaPrincipal;
const agent = (id: string): KodaPrincipal => ({ actorType: 'agent', id }) as unknown as KodaPrincipal;
const runner = { actorType: 'runner', id: 'r1' } as unknown as KodaPrincipal;

describe('PermissionService', () => {
  let store: InMemoryPermissionStore;
  let cache: FakeCacheManager;
  let permissionCache: PermissionCache;
  let service: PermissionService;

  beforeEach(() => {
    store = new InMemoryPermissionStore();
    cache = new FakeCacheManager();
    permissionCache = new PermissionCache(cache as never);
    service = new PermissionService(store.roleRepo() as never, store.bindingRepo() as never, permissionCache);
    store.addUser('u1');
    store.projects.add('p1');
    store.projects.add('p2');
  });

  it('AC-1: a developer binding in p1 grants ticket.create there', async () => {
    store.bind({ type: 'USER', id: 'u1' }, 'developer', 'p1');
    expect(await service.can(user('u1'), 'ticket.create', { projectId: 'p1' })).toEqual({
      allowed: true,
      reason: 'granted',
    });
  });

  it('AC-2: a developer cannot ticket.delete', async () => {
    store.bind({ type: 'USER', id: 'u1' }, 'developer', 'p1');
    expect(await service.can(user('u1'), 'ticket.delete', { projectId: 'p1' })).toEqual({
      allowed: false,
      reason: 'not-granted',
    });
  });

  it('AC-3: a p1 binding grants nothing in p2', async () => {
    store.bind({ type: 'USER', id: 'u1' }, 'developer', 'p1');
    expect((await service.can(user('u1'), 'ticket.create', { projectId: 'p2' })).allowed).toBe(false);
  });

  it('AC-4: a projectId-null reviewer binding applies in every project', async () => {
    store.bind({ type: 'AGENT', id: 'a1' }, 'reviewer', null);
    expect(
      (await service.can(agent('a1'), 'ticket.transition.close', { projectId: 'p2' })).allowed,
    ).toBe(true);
  });

  it('AC-5: a global admin binding grants user.create', async () => {
    store.bind({ type: 'USER', id: 'u1' }, 'admin', null);
    expect((await service.can(user('u1'), 'user.create')).allowed).toBe(true);
  });

  it('AC-6: admin without owner is denied role.binding.owner', async () => {
    store.bind({ type: 'USER', id: 'u1' }, 'admin', null);
    expect((await service.can(user('u1'), 'role.binding.owner')).allowed).toBe(false);
  });

  it('AC-7: legacy User.role ADMIN with no bindings grants user.create', async () => {
    store.addUser('legacy', 'ADMIN');
    expect((await service.can(user('legacy'), 'user.create')).allowed).toBe(true);
  });

  it('AC-8: an implicit key is allowed with reason implicit', async () => {
    expect(await service.can(user('u1'), 'notification.read')).toEqual({ allowed: true, reason: 'implicit' });
  });

  it('a public key is allowed with reason public', async () => {
    expect(await service.can(user('u1'), 'health.read')).toEqual({ allowed: true, reason: 'public' });
  });

  it('AC-9: a project key without a projectId is no-project', async () => {
    expect(await service.can(user('u1'), 'ticket.create', {})).toEqual({
      allowed: false,
      reason: 'no-project',
    });
  });

  it('AC-10: an agent owner binding does not grant a user-only key', async () => {
    store.bind({ type: 'AGENT', id: 'a1' }, 'owner', null);
    expect(await service.can(agent('a1'), 'role.binding.owner')).toEqual({
      allowed: false,
      reason: 'principal-type',
    });
  });

  it('AC-11 and rule 1: a runner is denied with non-role-key, even for an unknown key', async () => {
    expect(await service.can(runner, 'ticket.read', { projectId: 'p1' })).toEqual({
      allowed: false,
      reason: 'non-role-key',
    });
    expect((await service.can(runner, 'no.such.key')).reason).toBe('non-role-key');
  });

  it('rule 2: a key outside the catalog is unknown-key', async () => {
    expect(await service.can(user('u1'), 'no.such.key')).toEqual({ allowed: false, reason: 'unknown-key' });
  });

  it('rule 4: a runner or system key is non-role-key for a user', async () => {
    expect(await service.can(user('u1'), 'system.approval.expire')).toEqual({
      allowed: false,
      reason: 'non-role-key',
    });
  });

  describe('own keys (rules 9)', () => {
    beforeEach(() => store.bind({ type: 'USER', id: 'u1' }, 'viewer', 'p1'));
    const ctx = (createdBy: { type: 'USER' | 'AGENT'; id: string } | null) => ({
      projectId: 'p1',
      resource: { createdBy },
    });

    it('AC-12: the creator is granted', async () => {
      expect(await service.can(user('u1'), 'comment.update', ctx({ type: 'USER', id: 'u1' }))).toEqual({
        allowed: true,
        reason: 'granted',
      });
    });

    it('AC-13: another creator is not-owner', async () => {
      expect(await service.can(user('u1'), 'comment.update', ctx({ type: 'USER', id: 'u2' }))).toEqual({
        allowed: false,
        reason: 'not-owner',
      });
    });

    it('a null creator is not-owner', async () => {
      expect((await service.can(user('u1'), 'comment.update', ctx(null))).reason).toBe('not-owner');
    });

    it('a creator of the same id but another type is not-owner', async () => {
      expect((await service.can(user('u1'), 'comment.update', ctx({ type: 'AGENT', id: 'u1' }))).reason).toBe(
        'not-owner',
      );
    });

    it('AC-14: no resource is not-owner', async () => {
      expect(await service.can(user('u1'), 'comment.update', { projectId: 'p1' })).toEqual({
        allowed: false,
        reason: 'not-owner',
      });
    });
  });

  describe('global admins in projects', () => {
    it('a global admin binding holds project keys in any project, including role.binding.manage', async () => {
      store.bind({ type: 'USER', id: 'u1' }, 'admin', null);
      for (const key of ['ticket.delete', 'role.binding.manage', 'approval.decide', 'approval.policy.manage']) {
        expect((await service.can(user('u1'), key, { projectId: 'p2' })).allowed).toBe(true);
      }
    });

    it('the global set of an owner or legacy admin also holds project keys', async () => {
      store.addUser('owner1');
      store.bind({ type: 'USER', id: 'owner1' }, 'owner', null);
      store.addUser('legacy', 'ADMIN');
      for (const id of ['owner1', 'legacy']) {
        const keys = await service.effectiveKeys({ type: 'USER', id }, 'global');
        expect(keys.has('ticket.delete')).toBe(true);
        const inProject = await service.effectiveKeys({ type: 'USER', id }, { projectId: 'p1' });
        expect(inProject.has('role.binding.manage')).toBe(true);
      }
    });

    it('a project-admin binding is not a global admin', async () => {
      store.bind({ type: 'USER', id: 'u1' }, 'project-admin', 'p1');
      const keys = await service.effectiveKeys({ type: 'USER', id: 'u1' }, 'global');
      expect(keys.has('ticket.delete')).toBe(false);
    });
  });

  describe('approval.decide narrowing', () => {
    it('an approval.decide@ entry grants approval.decide', async () => {
      store.roles.push({
        id: 'role-narrow', key: 'narrow', name: 'N', description: '', scope: 'PROJECT',
        system: false, locked: false, permissions: ['approval.decide@ticket.*'],
      });
      store.bind({ type: 'USER', id: 'u1' }, 'narrow', 'p1');
      expect((await service.can(user('u1'), 'approval.decide', { projectId: 'p1' })).allowed).toBe(true);
    });
  });

  describe('caching', () => {
    it('serves the second identical call from the cache', async () => {
      store.bind({ type: 'USER', id: 'u1' }, 'developer', 'p1');
      await service.can(user('u1'), 'ticket.create', { projectId: 'p1' });
      await service.can(user('u1'), 'ticket.read', { projectId: 'p1' });
      expect(cache.loads).toBe(1);
    });

    it('tags entries with permissions and a 60 s TTL', async () => {
      const spy = vi.spyOn(cache, 'get');
      await service.can(user('u1'), 'ticket.create', { projectId: 'p1' });
      expect(spy.mock.calls[0]?.[2]).toBe(60_000);
      expect(spy.mock.calls[0]?.[3]).toEqual({ tags: ['permissions'] });
    });

    it('PermissionCache.invalidate makes the next call recompute (memory strategy has no tag registry)', async () => {
      const binding = store.bind({ type: 'USER', id: 'u1' }, 'developer', 'p1');
      expect((await service.can(user('u1'), 'ticket.create', { projectId: 'p1' })).allowed).toBe(true);
      store.bindings = store.bindings.filter((b) => b.id !== binding.id);
      await permissionCache.invalidate();
      expect((await service.can(user('u1'), 'ticket.create', { projectId: 'p1' })).allowed).toBe(false);
      expect(cache.invalidations).toContain('permissions#tag');
    });
  });
});
