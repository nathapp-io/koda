import {
  AppException,
  ForbiddenAppException,
  NotFoundAppException,
  ValidationAppException,
} from '@nathapp/nestjs-common';
import type { KodaPrincipal } from '../auth/principal/koda-principal.types';
import { ConflictAppException } from '../common/exceptions/conflict-app.exception';
import { MembershipService } from './membership.service';
import { PermissionCache } from './permission-cache';
import { PermissionService } from './permission.service';
import { RoleAdminService } from './role-admin.service';
import type { RoleDomain } from './permissions.types';
import { FakeCacheManager, InMemoryPermissionStore } from './test-helpers/in-memory-permissions';

/**
 * US-005 / US-006 — RoleAdminService rules without a database: catalog validation, anti-escalation,
 * the system/locked/in-use delete order, duplicate keys including the concurrent insert, the binding
 * check order (route keys, lookups, scope, principal type, self-binding, escalation), and the
 * permission-cache invalidation every write owes the next `can` call.
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

/** The transaction manager double the in-memory store expects: it runs the callback immediately. */
const txManager = {
  run: (fn: () => Promise<unknown>) => fn(),
  getClient: () => undefined,
  isInTransaction: () => false,
};

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
    const membership = new MembershipService(
      store.roleRepo() as never,
      store.bindingRepo() as never,
      txManager as never,
      permissionCache,
      cache as never,
    );
    service = new RoleAdminService(
      store.roleRepo() as never,
      store.bindingRepo() as never,
      permissions,
      permissionCache,
      membership,
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
        new MembershipService(
          store.roleRepo() as never,
          store.bindingRepo() as never,
          txManager as never,
          permissionCache,
          cache as never,
        ),
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

  describe('binding routes (US-006)', () => {
    const AGENT = (id: string) => ({ type: 'AGENT' as const, id });
    let projectId: string;

    /** How many bindings of that principal the store holds. */
    const bindingsOf = (principalId: string) =>
      store.bindings.filter((entry) => entry.principalId === principalId);

    beforeEach(() => {
      projectId = 'project-alpha';
      store.projects.add(projectId);
      store.agents.add('agent-1');
      // A caller who may manage bindings inside the project but holds nothing else there.
      store.roles.push({
        id: 'role-binding-manager',
        key: 'binding-manager',
        name: 'Binding manager',
        description: '',
        scope: 'PROJECT',
        system: false,
        locked: false,
        permissions: ['role.binding.manage'],
      });
      store.addUser('binder-1');
      store.bind(USER('binder-1'), 'binding-manager', projectId);
    });

    const binder = (): KodaPrincipal => principal('binder-1');

    describe('listBindings', () => {
      it('AC-3 (unit): answers the repository page for a caller holding role.read', async () => {
        const page = await service.listBindings(owner, { principal: USER(owner.id) }, { current: 1, size: 50 });

        expect(page.size).toBe(50);
        expect(page.records.map((entry) => entry.roleKey)).toContain('owner');
        expect(store.calls).toContain('page:1:50');
      });

      it('AC-2 (unit): a member without role.read is refused before any read', async () => {
        const error = await thrown(() => service.listBindings(member, {}, { current: 1, size: 50 }));

        expect(error).toBeInstanceOf(ForbiddenAppException);
        expect(error.prefix).toBe('permissions');
        expect(store.calls.some((call) => call.startsWith('page:'))).toBe(false);
      });
    });

    describe('createBinding', () => {
      const developerInProject = (principalType: 'AGENT') => ({
        principalType,
        principalId: 'agent-1',
        roleKey: 'developer',
        projectId,
      });

      /** The one input every grant test starts from: an agent, a project role, a real project. */
      const grant = (caller: KodaPrincipal, overrides: Record<string, unknown> = {}) =>
        service.createBinding(caller, { ...developerInProject('AGENT'), ...overrides });

      it('AC-1 (unit): a binding manager grants an agent developer in its own project', async () => {
        const view = await service.createBinding(binder(), {
          principalType: 'AGENT',
          principalId: 'agent-1',
          roleKey: 'binding-manager',
          projectId,
        });

        expect(view).toMatchObject({
          principalType: 'AGENT',
          principalId: 'agent-1',
          roleKey: 'binding-manager',
          projectId,
          grantedByType: 'USER',
          grantedById: 'binder-1',
        });
        expect(bindingsOf('agent-1')).toHaveLength(1);
        expect(cache.invalidations.length).toBeGreaterThan(0);
      });

      it('AC-2/AC-10 (unit): without role.binding.global a global grant is refused and stores nothing', async () => {
        const error = await thrown(() => grant(binder(), { projectId: null }));

        expect(error).toBeInstanceOf(ForbiddenAppException);
        expect(error.prefix).toBe('permissions');
        expect(bindingsOf('agent-1')).toHaveLength(0);
      });

      it('AC-4 (unit): an admin without role.binding.owner cannot grant the owner role', async () => {
        const error = await thrown(() =>
          service.createBinding(admin, {
            principalType: 'USER',
            principalId: 'someone',
            roleKey: 'owner',
            projectId: null,
          }),
        );

        expect(error).toBeInstanceOf(ForbiddenAppException);
        expect(error.prefix).toBe('permissions');
      });

      it('AC-6 (unit): a GLOBAL role with a project id is 400 permissions.scopeMismatch', async () => {
        const error = await thrown(() => grant(owner, { roleKey: 'admin' }));

        expect(error).toBeInstanceOf(ValidationAppException);
        expect(error.prefix).toBe('permissions.scopeMismatch');
      });

      it('AC-7 (unit): an unknown roleKey is 404 permissions.roleNotFound', async () => {
        const error = await thrown(() => grant(owner, { roleKey: 'no-such-role' }));

        expect(error).toBeInstanceOf(NotFoundAppException);
        expect(error.prefix).toBe('permissions.roleNotFound');
      });

      it('AC-24/AC-25 (unit): an unknown project is 404 projects', async () => {
        const error = await thrown(() => grant(owner, { projectId: 'missing-project' }));

        expect(error).toBeInstanceOf(NotFoundAppException);
        expect(error.prefix).toBe('projects');
      });

      it('AC-8 (unit): a principalId naming no user is 404 permissions.principalNotFound', async () => {
        const error = await thrown(() => grant(owner, { principalType: 'USER', principalId: 'nobody' }));

        expect(error).toBeInstanceOf(NotFoundAppException);
        expect(error.prefix).toBe('permissions.principalNotFound');
      });

      it('AC-20 (unit): the owner role bound to an agent is 400 permissions.principalType', async () => {
        const error = await thrown(() => grant(owner, { roleKey: 'owner', projectId: null }));

        expect(error).toBeInstanceOf(ValidationAppException);
        expect(error.prefix).toBe('permissions.principalType');
      });

      it('AC-11 (unit): binding the caller itself is 403 permissions.selfBinding', async () => {
        const error = await thrown(() =>
          grant(owner, { principalType: 'USER', principalId: owner.id }),
        );

        expect(error).toBeInstanceOf(ForbiddenAppException);
        expect(error.prefix).toBe('permissions.selfBinding');
      });

      it('AC-26 (unit): a key the role grants and the caller lacks is 403 permissions.escalation', async () => {
        const error = await thrown(() => grant(binder()));

        expect(error).toBeInstanceOf(ForbiddenAppException);
        expect(error.prefix).toBe('permissions.escalation');
        expect(bindingsOf('agent-1')).toHaveLength(0);
        expect(cache.invalidations).toEqual([]);
      });

      it('AC-9 (unit): a role the caller holds in full is granted', async () => {
        const view = await grant(binder(), { roleKey: 'binding-manager' });

        expect(view).toMatchObject({ roleKey: 'binding-manager', projectId });
      });

      it('AC-28 (unit): re-posting an identical grant answers the existing binding', async () => {
        const first = await grant(binder(), { roleKey: 'binding-manager' });
        const second = await grant(binder(), { roleKey: 'binding-manager' });

        expect(second.id).toBe(first.id);
        expect(bindingsOf('agent-1')).toHaveLength(1);
      });
    });

    describe('removeBinding', () => {
      it('AC-13/AC-14 (unit): an owner removes another user\'s global admin binding', async () => {
        store.addUser('target-1', 'ADMIN');
        const binding = store.bind(USER('target-1'), 'admin', null);

        await service.removeBinding(owner, binding.id);

        expect(store.bindings.some((entry) => entry.id === binding.id)).toBe(false);
        expect(store.users.get('target-1')?.role).toBe('MEMBER');
      });

      it('AC-15 (unit): with a second owner binding an owner may remove it', async () => {
        store.addUser('owner-2');
        const other = store.bind(USER('owner-2'), 'owner', null);

        await service.removeBinding(owner, other.id);

        expect(store.bindings.some((entry) => entry.id === other.id)).toBe(false);
        expect(store.calls).toContain('lock-owner');
      });

      it('AC-22 (unit): removing the last owner binding is refused by the owner lock', async () => {
        // A caller holding every key the owner role holds without holding an owner binding itself:
        // only such a caller gets past the escalation rule and reaches the owner lock.
        store.roles.push({
          id: 'role-superuser',
          key: 'superuser',
          name: 'Superuser',
          description: '',
          scope: 'GLOBAL',
          system: false,
          locked: false,
          permissions: ['*'],
        });
        store.addUser('grantor-2');
        store.bind(USER('grantor-2'), 'superuser', null);
        // The store's only owner binding belongs to someone else, so removing it is the last one.
        store.bindings = store.bindings.filter((entry) => entry.roleId !== store.roleByKey('owner').id);
        store.addUser('owner-2');
        const lastOwner = store.bind(USER('owner-2'), 'owner', null);

        const error = await thrown(() => service.removeBinding(principal('grantor-2'), lastOwner.id));

        expect(error).toBeInstanceOf(ForbiddenAppException);
        expect(error.prefix).toBe('permissions.ownerLocked');
        expect(store.bindings.some((entry) => entry.id === lastOwner.id)).toBe(true);
      });

      it('AC-16 (unit): an admin cannot delete an owner binding at all', async () => {
        store.addUser('owner-2');
        const other = store.bind(USER('owner-2'), 'owner', null);

        const error = await thrown(() => service.removeBinding(admin, other.id));

        expect(error).toBeInstanceOf(ForbiddenAppException);
        expect(error.prefix).toBe('permissions');
        expect(store.bindings.some((entry) => entry.id === other.id)).toBe(true);
      });

      it('AC-12 (unit): deleting the caller\'s own binding is 403 permissions.selfBinding', async () => {
        const own = store.bind(USER(owner.id), 'viewer', projectId);

        const error = await thrown(() => service.removeBinding(owner, own.id));

        expect(error).toBeInstanceOf(ForbiddenAppException);
        expect(error.prefix).toBe('permissions.selfBinding');
        expect(store.bindings.some((entry) => entry.id === own.id)).toBe(true);
      });

      it('AC-17 (unit): a project binding needs role.binding.manage in that project', async () => {
        const binding = store.bind(USER('someone'), 'binding-manager', projectId);

        const error = await thrown(() => service.removeBinding(member, binding.id));

        expect(error).toBeInstanceOf(ForbiddenAppException);
        expect(error.prefix).toBe('permissions');
        expect(store.bindings.some((entry) => entry.id === binding.id)).toBe(true);
      });

      it('AC-18 (unit): the project binding manager removes another principal\'s binding', async () => {
        const binding = store.bind(USER('someone'), 'binding-manager', projectId);

        await service.removeBinding(binder(), binding.id);

        expect(store.bindings.some((entry) => entry.id === binding.id)).toBe(false);
      });

      it('AC-21 (unit): a global binding needs role.binding.global, which this project binder lacks', async () => {
        const binding = store.bind(USER('someone'), 'owner', null);

        const error = await thrown(() => service.removeBinding(binder(), binding.id));

        expect(error).toBeInstanceOf(ForbiddenAppException);
        expect(error.prefix).toBe('permissions');
        expect(store.bindings.some((entry) => entry.id === binding.id)).toBe(true);
      });

      it('AC-21 (unit): escalation is decided from the stored binding\'s keys', async () => {
        const binding = store.bind(USER('someone'), 'developer', projectId);

        const error = await thrown(() => service.removeBinding(binder(), binding.id));

        expect(error).toBeInstanceOf(ForbiddenAppException);
        expect(error.prefix).toBe('permissions.escalation');
        expect(store.bindings.some((entry) => entry.id === binding.id)).toBe(true);
      });

      it('404s an unknown id with permissions.bindingNotFound', async () => {
        const error = await thrown(() => service.removeBinding(owner, 'missing'));

        expect(error).toBeInstanceOf(NotFoundAppException);
        expect(error.prefix).toBe('permissions.bindingNotFound');
      });
    });
  });
});
