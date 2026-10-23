import type { AppException } from '@nathapp/nestjs-common';
import { NotFoundAppException } from '@nathapp/nestjs-common';
import { ConflictAppException } from '../common/exceptions/conflict-app.exception';
import { AfterCommitService } from './after-commit.service';
import { MembershipService } from './membership.service';
import { PermissionCache } from './permission-cache';
import type { Granter } from './permissions.types';
import { FakeCacheManager, InMemoryPermissionStore } from './test-helpers/in-memory-permissions';

/**
 * Permissions P1 US-001 — the removal guards of `MembershipService.removeBinding` without a database:
 * the project-members advisory lock, the last-active-Project-Admin refusal, its override, and the
 * step order that keeps them under the lock. The integration suite runs the HTTP criteria against
 * Postgres; this file pins the service's own contract.
 */

const BY: Granter = { type: 'SYSTEM', id: 'test' };
const USER = (id: string) => ({ type: 'USER' as const, id });

/** A transaction manager double that runs the callback immediately, outside any transaction. */
const immediateTx = () => ({
  run: <T>(fn: () => Promise<T>): Promise<T> => fn(),
  isInTransaction: () => false,
});

describe('MembershipService.removeBinding removal guards (US-001)', () => {
  let store: InMemoryPermissionStore;
  let cache: FakeCacheManager;
  let bindings: ReturnType<InMemoryPermissionStore['bindingRepo']>;
  let service: MembershipService;

  const create = (principalId: string, roleKey: string, projectId: string | null) =>
    service.createBinding({ principal: USER(principalId), roleKey, projectId }, BY);

  beforeEach(() => {
    store = new InMemoryPermissionStore();
    cache = new FakeCacheManager();
    bindings = store.bindingRepo();
    service = new MembershipService(
      store.roleRepo() as never,
      bindings as never,
      immediateTx() as never,
      new PermissionCache(cache as never),
      cache as never,
      new AfterCommitService(),
    );
    store.addUser('u1');
    store.addUser('u2');
    store.projects.add('p1');
    store.projects.add('p2');
  });

  describe('AC-11: the project-members lock', () => {
    it('records lockProjectMembers for the project before lockUser for the binding\'s user', async () => {
      const kept = await create('u2', 'project-admin', 'p1');
      const removed = await create('u1', 'project-admin', 'p1');
      expect(kept.id).not.toBe(removed.id);
      store.calls.length = 0;

      await service.removeBinding(removed.id);

      const projectLock = store.calls.indexOf('lock-project-members:p1');
      const userLock = store.calls.indexOf('lock-user:u1');
      expect(projectLock).toBeGreaterThanOrEqual(0);
      expect(userLock).toBeGreaterThanOrEqual(0);
      expect(projectLock).toBeLessThan(userLock);
    });

    it('takes no project lock for a binding that is not a project admin\'s', async () => {
      await create('u2', 'project-admin', 'p1');
      const developer = await create('u1', 'developer', 'p1');
      store.calls.length = 0;

      await service.removeBinding(developer.id);

      expect(store.calls.some((call) => call.startsWith('lock-project-members:'))).toBe(false);
    });
  });

  describe('the last active Project Admin refusal', () => {
    it('refuses the removal with 409 members.lastAdmin and keeps the binding', async () => {
      const binding = await create('u1', 'project-admin', 'p1');

      const error = await service.removeBinding(binding.id).catch((reason: unknown) => reason);

      expect(error).toBeInstanceOf(ConflictAppException);
      expect((error as AppException).prefix).toBe('members.lastAdmin');
      expect((error as AppException).httpStatus).toBe(409);
      expect(store.bindings.some((row) => row.id === binding.id)).toBe(true);
    });

    it('removes the binding while a second enabled project admin remains', async () => {
      await create('u2', 'project-admin', 'p1');
      const binding = await create('u1', 'project-admin', 'p1');

      await expect(service.removeBinding(binding.id)).resolves.toBeUndefined();

      expect(store.bindings.some((row) => row.id === binding.id)).toBe(false);
    });

    it('removes the only project-admin binding when its user is disabled', async () => {
      store.addUser('off', 'MEMBER', true);
      const binding = await create('off', 'project-admin', 'p1');

      await expect(service.removeBinding(binding.id)).resolves.toBeUndefined();

      expect(store.bindings.some((row) => row.id === binding.id)).toBe(false);
    });

    it('removes the last project admin when the caller passes the override', async () => {
      const binding = await create('u1', 'project-admin', 'p1');

      await expect(
        service.removeBinding(binding.id, { lastProjectAdminOverride: true }),
      ).resolves.toBeUndefined();

      expect(store.bindings.some((row) => row.id === binding.id)).toBe(false);
    });

    it('counts only the binding\'s own project', async () => {
      await create('u2', 'project-admin', 'p2');
      const binding = await create('u1', 'project-admin', 'p1');

      const error = await service.removeBinding(binding.id).catch((reason: unknown) => reason);

      expect(error).toBeInstanceOf(ConflictAppException);
      expect(store.calls).toContain('count-active-project-admins:p1');
      expect(store.bindings.some((row) => row.id === binding.id)).toBe(true);
    });
  });

  describe('AC-12: a binding whose user row is gone', () => {
    it('treats it as inactive and resolves without consulting the active-admin count', async () => {
      const binding = store.bind(USER('ghost'), 'project-admin', 'p1');
      // A canary: the count would fail loudly, so a guard that reached it could not resolve.
      store.activeAdminCountFailure = new Error('countActiveProjectAdmins ran for a missing user row');
      store.calls.length = 0;

      await expect(service.removeBinding(binding.id)).resolves.toBeUndefined();

      expect(store.bindings.some((row) => row.id === binding.id)).toBe(false);
      expect(store.calls).not.toContain('count-active-project-admins:p1');
    });
  });

  describe('AC-13: the active-admin count fails', () => {
    it('propagates the error and leaves the binding in place', async () => {
      const binding = await create('u1', 'project-admin', 'p1');
      const failure = new Error('countActiveProjectAdmins failed');
      store.activeAdminCountFailure = failure;

      await expect(service.removeBinding(binding.id)).rejects.toBe(failure);

      expect(store.bindings.some((row) => row.id === binding.id)).toBe(true);
    });
  });

  describe('AC-14: an unknown id without options', () => {
    it('still answers 404 permissions.bindingNotFound before taking any lock', async () => {
      store.calls.length = 0;

      const error = await service.removeBinding('missing-binding').catch((reason: unknown) => reason);

      expect(error).toBeInstanceOf(NotFoundAppException);
      expect(JSON.stringify(error)).toContain('permissions.bindingNotFound');
      expect(store.calls).toEqual([]);
    });
  });
});
