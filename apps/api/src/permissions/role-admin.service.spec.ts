import {
  AppException,
  ForbiddenAppException,
  NotFoundAppException,
  ValidationAppException,
} from '@nathapp/nestjs-common';
import type { KodaPrincipal } from '../auth/principal/koda-principal.types';
import { ConflictAppException } from '../common/exceptions/conflict-app.exception';
import { PermissionCache } from './permission-cache';
import { PermissionService } from './permission.service';
import { RoleAdminService } from './role-admin.service';
import type { RoleDomain } from './permissions.types';
import { FakeCacheManager, InMemoryPermissionStore } from './test-helpers/in-memory-permissions';

/**
 * US-005 — RoleAdminService rules without a database: catalog validation, anti-escalation, the
 * system/locked/in-use delete order, duplicate keys including the concurrent insert, and the
 * permission-cache invalidation every role write owes the next `can` call.
 */

const USER = (id: string) => ({ type: 'USER' as const, id });
const principal = (id: string, role: 'MEMBER' | 'ADMIN' = 'MEMBER'): KodaPrincipal => ({
  actorType: 'user',
  id,
  role,
  email: `${id}@koda.test`,
});

/** The thrown `AppException`, asserted to be one so `prefix`/`httpStatus` can be read by name. */
async function thrown(run: () => Promise<unknown>): Promise<AppException> {
  const error = await run().then(
    () => null,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(AppException);
  return error as AppException;
}

describe('RoleAdminService', () => {
  let store: InMemoryPermissionStore;
  let cache: FakeCacheManager;
  let permissionCache: PermissionCache;
  let service: RoleAdminService;
  let owner: KodaPrincipal;
  let admin: KodaPrincipal;
  let member: KodaPrincipal;
  let granter: KodaPrincipal;

  const role = (key: string): RoleDomain => store.roleByKey(key);

  beforeEach(() => {
    store = new InMemoryPermissionStore();
    cache = new FakeCacheManager();
    permissionCache = new PermissionCache(cache as never);
    const permissions = new PermissionService(
      store.roleRepo() as never,
      store.bindingRepo() as never,
      permissionCache,
    );
    service = new RoleAdminService(
      store.roleRepo() as never,
      store.bindingRepo() as never,
      permissions,
      permissionCache,
    );

    // A caller who may administer roles without holding every key: the escalation tests' baseline.
    store.roles.push({
      id: 'role-role-granter',
      key: 'role-granter',
      name: 'Role granter',
      description: '',
      scope: 'GLOBAL',
      system: false,
      locked: false,
      permissions: ['role.read', 'role.manage'],
    });

    owner = principal('owner-1');
    admin = principal('admin-1');
    member = principal('member-1');
    granter = principal('granter-1');
    for (const user of [owner, admin, member, granter]) store.addUser(user.id);
    store.bind(USER(owner.id), 'owner', null);
    store.bind(USER(admin.id), 'admin', null);
    store.bind(USER(member.id), 'member', null);
    store.bind(USER(granter.id), 'role-granter', null);
  });

  describe('assertCan', () => {
    it('AC-2/AC-27 (unit): a member is refused role.manage with the bare permissions prefix', async () => {
      const error = await thrown(() => service.assertCan(member, 'role.manage'));

      expect(error).toBeInstanceOf(ForbiddenAppException);
      expect(error.prefix).toBe('permissions');
      expect(error.httpStatus).toBe(403);
    });

    it('lets a global owner through every role key', async () => {
      await expect(service.assertCan(owner, 'role.manage')).resolves.toBeUndefined();
    });
  });

  describe('listRoles', () => {
    it('AC-1 (unit): returns the roles the repository holds and invalidates nothing', async () => {
      const roles = await service.listRoles(owner);

      expect(roles.map((entry) => entry.key)).toContain('developer');
      expect(roles).toHaveLength(store.roles.length);
      expect(cache.invalidations).toEqual([]);
    });

    it('AC-2 (unit): a member cannot read the role list', async () => {
      const error = await thrown(() => service.listRoles(member));

      expect(error).toBeInstanceOf(ForbiddenAppException);
      expect(error.prefix).toBe('permissions');
      expect(store.calls).not.toContain('find-roles');
    });
  });

  describe('createRole', () => {
    const qa = {
      key: 'qa',
      name: 'QA',
      scope: 'PROJECT' as const,
      permissions: ['ticket.read', 'comment.create'],
    };

    it('AC-3 (unit): creates an unlocked non-system role and drops the permission cache', async () => {
      await service.listRoles(owner);
      const before = cache.invalidations.length;

      const created = await service.createRole(owner, qa);

      expect(created).toMatchObject({ key: 'qa', name: 'QA', scope: 'PROJECT', system: false, locked: false });
      expect(created.permissions).toEqual(['ticket.read', 'comment.create']);
      expect(cache.invalidations.length).toBeGreaterThan(before);
    });

    it('AC-4 (unit): an entry outside the catalog is a 400 permissions.unknownEntry', async () => {
      const error = await thrown(() => service.createRole(owner, { ...qa, permissions: ['no.such.key'] }));

      expect(error).toBeInstanceOf(ValidationAppException);
      expect(error.prefix).toBe('permissions.unknownEntry');
      expect(error.httpStatus).toBe(400);
    });

    it('AC-5 (unit): a global key inside a PROJECT role is a 400 permissions.scopeMismatch', async () => {
      const error = await thrown(() => service.createRole(owner, { ...qa, permissions: ['user.create'] }));

      expect(error).toBeInstanceOf(ValidationAppException);
      expect(error.prefix).toBe('permissions.scopeMismatch');
      expect(error.httpStatus).toBe(400);
    });

    it('AC-6/AC-25 (unit): nothing is stored when validation or escalation refuses', async () => {
      await thrown(() => service.createRole(owner, { ...qa, permissions: ['no.such.key'] }));
      await thrown(() => service.createRole(admin, { ...qa, permissions: ['role.binding.owner'] }));

      expect(store.roles.some((entry) => entry.key === 'qa')).toBe(false);
      expect(cache.invalidations).toEqual([]);
    });

    it('AC-7 (unit): an existing key is a 409 permissions.roleKeyTaken', async () => {
      const error = await thrown(() => service.createRole(owner, { ...qa, key: 'developer' }));

      expect(error).toBeInstanceOf(ConflictAppException);
      expect(error.prefix).toBe('permissions.roleKeyTaken');
      expect(error.httpStatus).toBe(409);
    });

    it('AC-24 (unit): losing the unique-index race is the same 409, not a 500', async () => {
      const racing = new RoleAdminService(
        store.racingRoleRepo() as never,
        store.bindingRepo() as never,
        new PermissionService(store.roleRepo() as never, store.bindingRepo() as never, permissionCache),
        permissionCache,
      );

      const error = await thrown(() => racing.createRole(owner, qa));

      expect(error).toBeInstanceOf(ConflictAppException);
      expect(error.prefix).toBe('permissions.roleKeyTaken');
    });

    it('AC-8 (unit): a global key the caller does not hold is a 403 permissions.escalation', async () => {
      const error = await thrown(() =>
        service.createRole(admin, { ...qa, scope: 'GLOBAL', permissions: ['role.binding.owner'] }),
      );

      expect(error).toBeInstanceOf(ForbiddenAppException);
      expect(error.prefix).toBe('permissions.escalation');
      expect(error.httpStatus).toBe(403);
    });

    it('counts an .own entry as its base key when checking escalation', async () => {
      // The granter may administer roles but holds no `comment.update`; the owner holds everything.
      await expect(
        service.createRole(owner, { ...qa, permissions: ['comment.update.own'] }),
      ).resolves.toMatchObject({ key: 'qa' });
      const error = await thrown(() =>
        service.createRole(granter, { ...qa, key: 'qa2', permissions: ['comment.update.own'] }),
      );
      expect(error.prefix).toBe('permissions.escalation');
    });

    it('counts a narrowed approval.decide entry as approval.decide when checking escalation', async () => {
      const error = await thrown(() =>
        service.createRole(granter, { ...qa, permissions: ['approval.decide@ticket.transition.close'] }),
      );

      expect(error.prefix).toBe('permissions.escalation');
    });

    it('allows an empty permission list', async () => {
      await expect(service.createRole(owner, { ...qa, permissions: [] })).resolves.toMatchObject({
        key: 'qa',
        permissions: [],
      });
    });
  });

  describe('updateRole', () => {
    const withPermissions = (permissions: string[]) => ({ permissions });

    it('AC-11 (unit): an admin may narrow an unlocked system role', async () => {
      const updated = await service.updateRole(admin, role('developer').id, withPermissions(['ticket.read']));

      expect(updated.permissions).toEqual(['ticket.read']);
      expect(role('developer').permissions).toEqual(['ticket.read']);
      expect(cache.invalidations.length).toBeGreaterThan(0);
    });

    it('AC-12 (unit): an unknown entry on PATCH is a 400 permissions.unknownEntry and changes nothing', async () => {
      const before = role('developer').permissions;
      const error = await thrown(() =>
        service.updateRole(admin, role('developer').id, withPermissions(['bad.key'])),
      );

      expect(error).toBeInstanceOf(ValidationAppException);
      expect(error.prefix).toBe('permissions.unknownEntry');
      expect(role('developer').permissions).toEqual(before);
      expect(cache.invalidations).toEqual([]);
    });

    it('AC-13 (unit): a global key in a PROJECT role is a 400 permissions.scopeMismatch', async () => {
      const error = await thrown(() =>
        service.updateRole(admin, role('developer').id, withPermissions(['user.create'])),
      );

      expect(error).toBeInstanceOf(ValidationAppException);
      expect(error.prefix).toBe('permissions.scopeMismatch');
      expect(error.httpStatus).toBe(400);
    });

    it('AC-9/AC-10 (unit): escalation is a 403 and the stored permissions stay unchanged', async () => {
      const before = role('member').permissions;
      const error = await thrown(() => service.updateRole(admin, role('member').id, withPermissions(['*'])));

      expect(error).toBeInstanceOf(ForbiddenAppException);
      expect(error.prefix).toBe('permissions.escalation');
      expect(role('member').permissions).toEqual(before);
      expect(cache.invalidations).toEqual([]);
    });

    it('AC-14 (unit): renaming a system role is a 400 permissions.systemRole', async () => {
      const error = await thrown(() => service.updateRole(admin, role('developer').id, { name: 'Dev' }));

      expect(error).toBeInstanceOf(ValidationAppException);
      expect(error.prefix).toBe('permissions.systemRole');
      expect(error.httpStatus).toBe(400);
      expect(role('developer').name).toBe('Developer');
    });

    it('AC-15 (unit): the locked owner role is a 403 permissions.ownerLocked', async () => {
      const error = await thrown(() =>
        service.updateRole(owner, role('owner').id, { description: 'Changed' }),
      );

      expect(error).toBeInstanceOf(ForbiddenAppException);
      expect(error.prefix).toBe('permissions.ownerLocked');
      expect(role('owner').description).toBe('');
    });

    it('AC-26 (unit): a validation or escalation refusal leaves the role untouched', async () => {
      const before = { ...role('developer') };
      await thrown(() => service.updateRole(owner, role('developer').id, { permissions: ['bad.key'] }));
      await thrown(() => service.updateRole(admin, role('developer').id, { permissions: ['role.binding.owner'] }));

      expect(role('developer')).toEqual(before);
    });

    it('404s an unknown id with permissions.roleNotFound', async () => {
      const error = await thrown(() => service.updateRole(owner, 'missing', withPermissions(['ticket.read'])));

      expect(error).toBeInstanceOf(NotFoundAppException);
      expect(error.prefix).toBe('permissions.roleNotFound');
      expect(error.httpStatus).toBe(404);
    });

    it('writes only the fields the patch names, leaving key and scope fixed', async () => {
      const updated = await service.updateRole(owner, role('developer').id, { description: 'Renamed use' });

      expect(updated).toMatchObject({ key: 'developer', scope: 'PROJECT', description: 'Renamed use' });
      expect(updated.permissions).toEqual(role('developer').permissions);
    });
  });

  describe('deleteRole', () => {
    it('AC-19/AC-20 (unit): deletes an unlocked custom role and invalidates the cache', async () => {
      const created = await service.createRole(owner, {
        key: 'qa', name: 'QA', scope: 'PROJECT', permissions: ['ticket.read'],
      });
      await service.listRoles(owner);
      const before = cache.invalidations.length;

      await service.deleteRole(owner, created.id);

      expect(store.roles.some((entry) => entry.key === 'qa')).toBe(false);
      expect(cache.invalidations.length).toBeGreaterThan(before);
    });

    it('AC-16 (unit): the locked owner role is a 403 permissions.ownerLocked', async () => {
      const error = await thrown(() => service.deleteRole(owner, role('owner').id));

      expect(error).toBeInstanceOf(ForbiddenAppException);
      expect(error.prefix).toBe('permissions.ownerLocked');
      expect(role('owner')).toBeDefined();
    });

    it('AC-17 (unit): an unlocked system role is a 403 permissions.systemRole', async () => {
      const error = await thrown(() => service.deleteRole(owner, role('viewer').id));

      expect(error).toBeInstanceOf(ForbiddenAppException);
      expect(error.prefix).toBe('permissions.systemRole');
      expect(error.httpStatus).toBe(403);
      expect(role('viewer')).toBeDefined();
    });

    it('AC-18 (unit): a role a binding references is a 409 permissions.roleInUse', async () => {
      const created = await service.createRole(owner, {
        key: 'qa', name: 'QA', scope: 'PROJECT', permissions: ['ticket.read'],
      });
      store.bind(USER('someone'), 'qa', null);

      const error = await thrown(() => service.deleteRole(owner, created.id));

      expect(error).toBeInstanceOf(ConflictAppException);
      expect(error.prefix).toBe('permissions.roleInUse');
      expect(error.httpStatus).toBe(409);
    });

    it('maps a concurrent binding insert (foreign key violation) to 409 permissions.roleInUse', async () => {
      const created = await service.createRole(owner, {
        key: 'qa', name: 'QA', scope: 'PROJECT', permissions: ['ticket.read'],
      });
      store.raceBindingOnDelete = true;

      const error = await thrown(() => service.deleteRole(owner, created.id));

      expect(error).toBeInstanceOf(ConflictAppException);
      expect(error.prefix).toBe('permissions.roleInUse');
    });

    it('runs the delete checks in the order locked, system, in use', async () => {
      // A locked system role that also has bindings answers the lock, not the system-role refusal.
      const ownerError = await thrown(() => service.deleteRole(owner, role('owner').id));
      expect(ownerError.prefix).toBe('permissions.ownerLocked');

      // An unlocked system role with bindings answers the system-role refusal, not the in-use conflict.
      store.bind(USER('someone'), 'viewer', null);
      const systemError = await thrown(() => service.deleteRole(owner, role('viewer').id));
      expect(systemError.prefix).toBe('permissions.systemRole');
    });

    it('404s an unknown id with permissions.roleNotFound', async () => {
      const error = await thrown(() => service.deleteRole(owner, 'missing'));

      expect(error).toBeInstanceOf(NotFoundAppException);
      expect(error.prefix).toBe('permissions.roleNotFound');
    });

    it('AC-27 (unit): a member cannot delete a role', async () => {
      const created = await service.createRole(owner, {
        key: 'qa', name: 'QA', scope: 'PROJECT', permissions: ['ticket.read'],
      });

      const error = await thrown(() => service.deleteRole(member, created.id));

      expect(error).toBeInstanceOf(ForbiddenAppException);
      expect(error.prefix).toBe('permissions');
      expect(store.roles.some((entry) => entry.key === 'qa')).toBe(true);
    });
  });
});
