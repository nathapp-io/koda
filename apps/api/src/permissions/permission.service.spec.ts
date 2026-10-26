import { Logger } from '@nestjs/common';
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
    service = new PermissionService(
      store.roleRepo() as never,
      store.bindingRepo() as never,
      permissionCache,
    );
    store.addUser('u1');
    store.projects.add('p1');
    store.projects.add('p2');
  });

  it('visibility AC-1: a global owner sees requests everywhere', async () => {
    const ref = { type: 'USER' as const, id: 'u1' };
    store.bind(ref, 'owner', null);
    expect(await service.approvalDecideScopes(ref)).toEqual({ everywhere: true, global: 'all', projects: [] });
  });

  it('visibility: sorts and deduplicates narrowed patterns and omits empty projects', async () => {
    const ref = { type: 'USER' as const, id: 'u1' };
    const bindings = { findEffectiveBindings: vi.fn().mockResolvedValue([]), findAccessibleProjectIds: vi.fn().mockResolvedValue(['p2', 'p1', 'p1']) };
    const subject = new PermissionService({} as never, bindings as never, permissionCache);
    vi.spyOn(subject, 'effectiveKeys').mockImplementation(async (_principal, scope) => new Set(
      scope === 'global' ? ['approval.decide@role.manage'] : scope.projectId === 'p1'
        ? ['approval.decide@ticket.delete', 'approval.decide@label.*', 'approval.decide@label.*', 'project.read'] : [],
    ));
    expect(await subject.approvalDecideScopes(ref)).toEqual({
      everywhere: false, global: ['role.manage'], projects: [{ projectId: 'p1', patterns: ['label.*', 'ticket.delete'] }],
    });
  });

  it('policy writes: roleIdsAnywhere includes every scope, distinct and ascending', async () => {
    const ref = { type: 'AGENT' as const, id: 'a1' };
    store.bind(ref, 'developer', 'p1');
    store.bind(ref, 'developer', 'p2');
    store.bind(ref, 'reviewer', 'p2');
    store.bind(ref, 'agent', null);
    expect(await service.roleIdsAnywhere(ref)).toEqual([
      store.roleByKey('developer').id, store.roleByKey('reviewer').id, store.roleByKey('agent').id,
    ].sort());
    expect(await service.roleIdsAnywhere({ type: 'AGENT', id: 'unbound' })).toEqual([]);
  });

  it('approval AC-14: roleIdsAt returns distinct, ascending effective role ids', async () => {
    const ref = { type: 'AGENT' as const, id: 'a1' };
    store.bind(ref, 'developer', 'p1');
    store.bind(ref, 'developer', null); // duplicate role via an everywhere binding
    store.bind(ref, 'agent', null);
    store.bind(ref, 'reviewer', 'p2'); // different project
    store.bind(ref, 'admin', 'p1'); // malformed GLOBAL binding, rejected by appliesIn
    expect(await service.roleIdsAt(ref, { projectId: 'p1' })).toEqual([
      store.roleByKey('agent').id, store.roleByKey('developer').id,
    ].sort());
    expect(await service.roleIdsAt(ref, 'global')).toEqual([store.roleByKey('agent').id]);
    expect(await service.roleIdsAt({ type: 'AGENT', id: 'unbound' }, { projectId: 'p1' })).toEqual([]);
  });

  it('bindings-only AC-8: three arguments and no legacy repository methods are needed', async () => {
    const findEffectiveBindings = vi.fn(async () => [{
      binding: { projectId: null }, roleKey: 'member', roleScope: 'GLOBAL', rolePermissions: ['agent.read'],
    }]);
    const bindings = { findEffectiveBindings, findAccessibleProjectIds: vi.fn() };
    const roles = {};
    const passThrough = { remember: async (_parts: string[], load: () => Promise<string[]>) => load() };
    const subject = new PermissionService(roles as never, bindings as never, passThrough as never);
    expect(await subject.can(user('u1'), 'agent.read')).toEqual({ allowed: true, reason: 'granted' });
    expect(findEffectiveBindings).toHaveBeenCalledExactlyOnceWith({ type: 'USER', id: 'u1' }, null);
    expect(bindings.findAccessibleProjectIds).not.toHaveBeenCalled();
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

  it('AC-7: a user with no bindings is granted nothing', async () => {
    store.addUser('legacy');
    expect(await service.can(user('legacy'), 'user.create')).toEqual({ allowed: false, reason: 'not-granted' });
    expect(await service.effectiveKeys({ type: 'USER', id: 'legacy' }, 'global')).toEqual(new Set());
    expect((await service.effectiveKeys({ type: 'USER', id: 'legacy' }, { projectId: 'p1' })).has('ticket.delete')).toBe(false);
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

    it('the global set of an owner also holds project keys', async () => {
      store.addUser('owner1');
      store.bind({ type: 'USER', id: 'owner1' }, 'owner', null);
      for (const id of ['owner1']) {
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

  describe('principalIdsWithKey', () => {
    const setup = () => {
      const roles = { findRolesByScope: vi.fn().mockResolvedValue([
        { id: 'admin', key: 'admin', permissions: [] },
        { id: 'owner', key: 'owner', permissions: [] },
        { id: 'read', key: 'read', permissions: ['project.read'] },
        { id: 'bad', key: 'bad', permissions: ['not.a.key'] },
        { id: 'other', key: 'other', permissions: ['agent.read'] },
      ]) };
      const bindings = { findCandidatePrincipalIds: vi.fn().mockResolvedValue(['u1', 'u2']) };
      const subject = new PermissionService(roles as never, bindings as never, permissionCache);
      return { subject, roles, bindings };
    };
    it('enumerates real keys using the shared repository doubles', async () => {
      store.bind({ type: 'USER', id: 'u1' }, 'developer', 'p1');
      store.bind({ type: 'USER', id: 'u1' }, 'viewer');
      store.addUser('u2');
      store.bind({ type: 'USER', id: 'u2' }, 'admin');
      store.addUser('u3');
      store.bind({ type: 'USER', id: 'u3' }, 'developer', 'p2');
      store.bind({ type: 'AGENT', id: 'a1' }, 'viewer', 'p1');
      expect(await service.principalIdsWithKey('USER', 'p1', 'project.read')).toEqual(['u1', 'u2']);
      expect(await service.principalIdsWithKey('AGENT', 'p1', 'project.read')).toEqual(['a1']);
    });
    it('expands global roles, excludes invalid entries, and filters every candidate by effectiveKeys', async () => {
      const { subject, roles, bindings } = setup();
      const effective = vi.spyOn(subject, 'effectiveKeys').mockImplementation(async (ref) => new Set(ref.id === 'u2' ? ['project.read'] : []));
      expect(await subject.principalIdsWithKey('USER', 'p1', 'project.read')).toEqual(['u2']);
      expect(roles.findRolesByScope).toHaveBeenCalledExactlyOnceWith('GLOBAL');
      expect(bindings.findCandidatePrincipalIds).toHaveBeenCalledExactlyOnceWith('USER', 'p1', ['admin', 'owner', 'read']);
      expect(effective.mock.calls).toEqual([
        [{ type: 'USER', id: 'u1' }, { projectId: 'p1' }],
        [{ type: 'USER', id: 'u2' }, { projectId: 'p1' }],
      ]);
    });
    it('F1: bounds concurrent effectiveKeys reads across multiple chunks and preserves sorted holders', async () => {
      const { subject, bindings } = setup();
      const candidates = Array.from({ length: 37 }, (_, i) => `u${String(i).padStart(2, '0')}`);
      bindings.findCandidatePrincipalIds.mockResolvedValue(candidates);
      let active = 0;
      let peak = 0;
      const effective = vi.spyOn(subject, 'effectiveKeys').mockImplementation(async (ref) => {
        active += 1;
        peak = Math.max(peak, active);
        await Promise.resolve();
        active -= 1;
        return new Set(Number(ref.id.slice(1)) % 2 === 0 ? ['project.read'] : []);
      });
      expect(await subject.principalIdsWithKey('USER', 'p1', 'project.read')).toEqual(
        candidates.filter((_, i) => i % 2 === 0),
      );
      expect(peak).toBeLessThanOrEqual(10);
      expect(active).toBe(0);
      expect(effective).toHaveBeenCalledTimes(candidates.length);
    });
    it('F1: a later chunk failure rejects unchanged without starting further chunks', async () => {
      const { subject, bindings } = setup();
      bindings.findCandidatePrincipalIds.mockResolvedValue(Array.from({ length: 37 }, (_, i) => `u${i}`));
      const error = new Error('later candidate read');
      const effective = vi.spyOn(subject, 'effectiveKeys').mockImplementation(async (ref) => {
        if (ref.id === 'u11') throw error;
        return new Set(['project.read']);
      });
      await expect(subject.principalIdsWithKey('USER', 'p1', 'project.read')).rejects.toBe(error);
      expect(effective).toHaveBeenCalledTimes(20);
      expect(effective).not.toHaveBeenCalledWith({ type: 'USER', id: 'u20' }, { projectId: 'p1' });
    });
    it('AC-10: propagates the original candidate effectiveKeys error without a partial answer', async () => {
      const { subject } = setup();
      const error = new Error('candidate read');
      vi.spyOn(subject, 'effectiveKeys').mockResolvedValueOnce(new Set(['project.read'])).mockRejectedValueOnce(error);
      await expect(subject.principalIdsWithKey('USER', 'p1', 'project.read')).rejects.toBe(error);
    });
    it.each(['roles', 'candidates'])('AC-16: propagates the original %s read error', async (source) => {
      const { subject, roles, bindings } = setup();
      const error = new Error(source);
      (source === 'roles' ? roles.findRolesByScope : bindings.findCandidatePrincipalIds).mockRejectedValueOnce(error);
      await expect(subject.principalIdsWithKey('USER', 'p1', 'project.read')).rejects.toBe(error);
    });
    it('AC-17: effectiveKeys keeps the invalid GLOBAL entry warning and grants nothing', async () => {
      const bindings = { findEffectiveBindings: vi.fn().mockResolvedValue([
        { binding: { projectId: null }, roleKey: 'bad', roleScope: 'GLOBAL', rolePermissions: ['not.a.key'] },
      ]) };
      const subject = new PermissionService({} as never, bindings as never, permissionCache);
      const warn = vi.spyOn(Logger.prototype, 'warn');
      warn.mockClear();
      expect(await subject.effectiveKeys({ type: 'USER', id: 'u1' }, { projectId: 'p1' })).toEqual(new Set());
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('role bad has an invalid permission entry'));
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
