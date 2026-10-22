import {
  AppException,
  ForbiddenAppException,
  NotFoundAppException,
  ValidationAppException,
} from '@nathapp/nestjs-common';
import type { KodaPrincipal } from '../auth/principal/koda-principal.types';
import { ConflictAppException } from '../common/exceptions/conflict-app.exception';
import { AfterCommitService } from './after-commit.service';
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
      { agentProjectScoping: true } as never,
    );
    const membership = new MembershipService(
      store.roleRepo() as never,
      store.bindingRepo() as never,
      txManager as never,
      permissionCache,
      cache as never,
      new AfterCommitService(),
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

  describe('listProjectRoles (US-003)', () => {
    it('answers every PROJECT role and no GLOBAL one, in the repository order', async () => {
      const roles = await service.listProjectRoles();

      expect(roles.every((entry) => entry.scope === 'PROJECT')).toBe(true);
      expect(roles.map((entry) => entry.key)).toContain('developer');
      expect(roles.map((entry) => entry.key)).not.toContain('owner');
      expect(roles.map((entry) => entry.key)).not.toContain('member');
      // System roles first, then by key — the custom role the store holds sorts after the seeded seven.
      const seeded = roles.filter((entry) => entry.system).map((entry) => entry.key);
      expect(seeded).toEqual([...seeded].sort());
      expect(roles.slice(0, seeded.length).every((entry) => entry.system)).toBe(true);
      // The route's `member.read` guard is the gate: the service asks no key of any caller.
      expect(cache.invalidations).toEqual([]);
    });

    it('reads through the scope-filtered, exhaustive repository reader — not a filtered capped list', async () => {
      // A custom PROJECT role and a custom GLOBAL role: only the first is assignable in a project, and the
      // reader is asked for the scope rather than for every role and filtered afterwards.
      store.roles.push(
        { id: 'role-qa', key: 'qa', name: 'QA', description: '', scope: 'PROJECT', system: false, locked: false, permissions: [] },
        { id: 'role-auditor', key: 'auditor', name: 'Auditor', description: '', scope: 'GLOBAL', system: false, locked: false, permissions: [] },
      );

      const roles = await service.listProjectRoles();

      expect(store.calls).toContain('find-roles-by-scope:PROJECT');
      expect(store.calls).not.toContain('find-roles');
      expect(roles.map((entry) => entry.key)).toContain('qa');
      expect(roles.map((entry) => entry.key)).not.toContain('auditor');
      expect(roles[roles.length - 1]?.key).toBe('qa');
    });
  });

  /**
   * US-004: the grant rules a write route runs **before** it stores a binding — role lookup, scope,
   * principal type, self-binding, escalation — in that order, and nothing else. The calling route's own
   * key (`member.add`, `invite.create`) is its gate, so no `role.binding.*` key is asked here.
   */
  describe('assertMayGrant (US-004)', () => {
    const projectId = 'project-alpha';
    let projectAdmin: KodaPrincipal;

    /** A caller holding exactly the given entries in the project, and no global authority. */
    const callerHolding = (id: string, entries: readonly string[]): KodaPrincipal => {
      const roleKey = `grantor-${id}`;
      store.roles.push({
        id: `role-${roleKey}`,
        key: roleKey,
        name: `Grantor ${id}`,
        description: '',
        scope: 'PROJECT',
        system: false,
        locked: false,
        permissions: [...entries],
      });
      store.addUser(id);
      store.bind(USER(id), roleKey, projectId);
      return principal(id);
    };

    beforeEach(() => {
      store.projects.add(projectId);
      store.agents.add('agent-1');
      store.addUser('project-admin-1');
      store.bind(USER('project-admin-1'), 'project-admin', projectId);
      projectAdmin = principal('project-admin-1');
      // A target role whose keys a narrow caller can hold: the escalation pass case.
      store.roles.push({
        id: 'role-reader',
        key: 'reader',
        name: 'Reader',
        description: '',
        scope: 'PROJECT',
        system: false,
        locked: false,
        permissions: ['ticket.read'],
      });
    });

    it('resolves the role for a caller that holds everything it confers, asking no route key', async () => {
      const granted = await service.assertMayGrant(projectAdmin, {
        roleKey: 'triager',
        projectId,
        principalType: 'USER',
        principalId: 'target-1',
      });

      expect(granted.key).toBe('triager');
      expect(granted.scope).toBe('PROJECT');
      // The route's own key is the gate: no `role.binding.*` and no `can` call happens here.
      expect(store.calls).not.toContain('lock-owner');
      expect(cache.invalidations).toEqual([]);
    });

    it('a caller holding only the granted keys may grant them, without role.binding.manage', async () => {
      const narrow = callerHolding('narrow-1', ['member.add', 'project.read', 'ticket.read']);

      const granted = await service.assertMayGrant(narrow, {
        roleKey: 'reader',
        projectId,
        principalType: 'USER',
        principalId: 'target-1',
      });

      expect(granted.key).toBe('reader');
    });

    it('an unknown role key is 404 permissions.roleNotFound before anything else', async () => {
      const error = await thrown(() =>
        service.assertMayGrant(projectAdmin, {
          roleKey: 'no-such-role',
          projectId,
          principalType: 'USER',
          principalId: 'target-1',
        }),
      );

      expect(error).toBeInstanceOf(NotFoundAppException);
      expect(error.prefix).toBe('permissions.roleNotFound');
      expect(error.httpStatus).toBe(404);
    });

    it('a GLOBAL role with a project id is 400 permissions.scopeMismatch, whatever the caller holds', async () => {
      const error = await thrown(() =>
        service.assertMayGrant(owner, {
          roleKey: 'admin',
          projectId,
          principalType: 'USER',
          principalId: 'target-1',
        }),
      );

      expect(error).toBeInstanceOf(ValidationAppException);
      expect(error.prefix).toBe('permissions.scopeMismatch');
      expect(error.httpStatus).toBe(400);
      // The sentence interpolates the role the caller tried to hand out in a project.
      expect(error.args).toEqual({ entry: 'admin' });
    });

    it('a role an AGENT principal can never hold is 400 permissions.principalType', async () => {
      const error = await thrown(() =>
        service.assertMayGrant(owner, {
          roleKey: 'owner',
          projectId: null,
          principalType: 'AGENT',
          principalId: 'agent-1',
        }),
      );

      expect(error).toBeInstanceOf(ValidationAppException);
      expect(error.prefix).toBe('permissions.principalType');
      expect(error.httpStatus).toBe(400);
    });

    it('binding a role to the caller itself is 403 permissions.selfBinding', async () => {
      const error = await thrown(() =>
        service.assertMayGrant(projectAdmin, {
          roleKey: 'viewer',
          projectId,
          principalType: 'USER',
          principalId: projectAdmin.id,
        }),
      );

      expect(error).toBeInstanceOf(ForbiddenAppException);
      expect(error.prefix).toBe('permissions.selfBinding');
      expect(error.httpStatus).toBe(403);
    });

    it('the same id of the other principal type is not the caller', async () => {
      // An agent and a user can share an id in principle: only a same-type match is a self-binding.
      const granted = await service.assertMayGrant(projectAdmin, {
        roleKey: 'reader',
        projectId,
        principalType: 'AGENT',
        principalId: projectAdmin.id,
      });

      expect(granted.key).toBe('reader');
    });

    it('a role conferring a key the caller does not hold is 403 permissions.escalation', async () => {
      const narrow = callerHolding('narrow-2', ['member.add', 'project.read', 'ticket.read']);

      const error = await thrown(() =>
        service.assertMayGrant(narrow, {
          roleKey: 'developer',
          projectId,
          principalType: 'USER',
          principalId: 'target-1',
        }),
      );

      expect(error).toBeInstanceOf(ForbiddenAppException);
      expect(error.prefix).toBe('permissions.escalation');
      expect(error.httpStatus).toBe(403);
    });

    it("escalation is read in the target's scope: a key held in another project does not carry", async () => {
      const otherProject = 'project-beta';
      store.projects.add(otherProject);
      store.addUser('elsewhere-admin');
      store.bind(USER('elsewhere-admin'), 'project-admin', otherProject);

      const error = await thrown(() =>
        service.assertMayGrant(principal('elsewhere-admin'), {
          roleKey: 'developer',
          projectId,
          principalType: 'USER',
          principalId: 'target-1',
        }),
      );

      expect(error).toBeInstanceOf(ForbiddenAppException);
      expect(error.prefix).toBe('permissions.escalation');
    });

    it('a null principal id (an address with no account yet) skips the self rule', async () => {
      const granted = await service.assertMayGrant(projectAdmin, {
        roleKey: 'viewer',
        projectId,
        principalType: 'USER',
        principalId: null,
      });

      expect(granted.key).toBe('viewer');
    });

    it('checks in the brief order: scope before self-binding, self-binding before escalation', async () => {
      const narrow = callerHolding('narrow-3', ['member.add', 'project.read']);

      // GLOBAL role, own id: the scope refusal comes first.
      const scopeError = await thrown(() =>
        service.assertMayGrant(narrow, {
          roleKey: 'admin',
          projectId,
          principalType: 'USER',
          principalId: narrow.id,
        }),
      );
      expect(scopeError.prefix).toBe('permissions.scopeMismatch');

      // An escalating role, own id: the self refusal comes first.
      const selfError = await thrown(() =>
        service.assertMayGrant(narrow, {
          roleKey: 'developer',
          projectId,
          principalType: 'USER',
          principalId: narrow.id,
        }),
      );
      expect(selfError.prefix).toBe('permissions.selfBinding');
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
        new PermissionService(
          store.roleRepo() as never,
          store.bindingRepo() as never,
          permissionCache,
          { agentProjectScoping: true } as never,
        ),
        permissionCache,
        new MembershipService(
          store.roleRepo() as never,
          store.bindingRepo() as never,
          txManager as never,
          permissionCache,
          cache as never,
          new AfterCommitService(),
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

    /**
     * B1: the implicit powers of a global `owner`/`admin` binding are not in its editable entry list.
     * A caller that holds only what the role routes need could clear `admin.permissions` and then bind
     * the emptied role; `MembershipService` mirrors that binding into a legacy `User.role = 'ADMIN'`,
     * which `PermissionService` turns into every project key. The escalation check must therefore
     * count what the binding confers, not what the role happens to store.
     */
    describe('the implicit powers of a global admin binding (B1)', () => {
      /** A caller holding exactly the two keys the role and binding routes need, and nothing else. */
      const restrictedGranter = (): KodaPrincipal => {
        store.roles.push({
          id: 'role-restricted-granter',
          key: 'restricted-granter',
          name: 'Restricted granter',
          description: '',
          scope: 'GLOBAL',
          system: false,
          locked: false,
          permissions: ['role.manage', 'role.binding.global'],
        });
        store.addUser('restricted-1');
        store.bind(USER('restricted-1'), 'restricted-granter', null);
        return principal('restricted-1');
      };

      it('refuses to empty the admin role: the caller does not hold what the role confers', async () => {
        const caller = restrictedGranter();
        const before = role('admin').permissions;

        const error = await thrown(() => service.updateRole(caller, role('admin').id, { permissions: [] }));

        expect(error).toBeInstanceOf(ForbiddenAppException);
        expect(error.prefix).toBe('permissions.escalation');
        expect(role('admin').permissions).toEqual(before);
      });

      it('refuses to bind a global admin role the caller only holds after editing it', async () => {
        const caller = restrictedGranter();
        store.addUser('promoted-target');
        // The hand-edited row the exploit leaves behind: the entries are gone, the binding still
        // promotes its target to a legacy ADMIN with every project key.
        store.roleByKey('admin').permissions = [];

        const error = await thrown(() =>
          service.createBinding(caller, {
            principalType: 'USER',
            principalId: 'promoted-target',
            roleKey: 'admin',
            projectId: null,
          }),
        );

        expect(error).toBeInstanceOf(ForbiddenAppException);
        expect(error.prefix).toBe('permissions.escalation');
        expect(bindingsOf('promoted-target')).toHaveLength(0);
      });

      it('refuses to remove a global admin binding whose role the caller could not grant', async () => {
        const caller = restrictedGranter();
        const binding = store.bind(USER('someone'), 'admin', null);

        const error = await thrown(() => service.removeBinding(caller, binding.id));

        expect(error).toBeInstanceOf(ForbiddenAppException);
        expect(error.prefix).toBe('permissions.escalation');
        expect(store.bindings.some((entry) => entry.id === binding.id)).toBe(true);
      });

      it('still lets a global admin edit and grant the admin role it holds in full', async () => {
        store.addUser('grantable-target');
        const target = store.roleByKey('admin');
        // The exact entry list an admin holds itself, exclusion included: the check compares the
        // whole conferred key set, so keeping the exclusion keeps the edit inside its own authority.
        const edited = await service.updateRole(admin, target.id, {
          permissions: ['*', '!role.binding.owner'],
        });

        expect(edited.permissions).toEqual(['*', '!role.binding.owner']);
        await expect(
          service.createBinding(admin, {
            principalType: 'USER',
            principalId: 'grantable-target',
            roleKey: 'admin',
            projectId: null,
          }),
        ).resolves.toMatchObject({ roleKey: 'admin', projectId: null });
      });

      it('refuses an edit that drops the admin role\'s owner-key exclusion', async () => {
        const error = await thrown(() =>
          service.updateRole(admin, role('admin').id, { permissions: ['*'] }),
        );

        expect(error).toBeInstanceOf(ForbiddenAppException);
        expect(error.prefix).toBe('permissions.escalation');
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
        // A caller holding every key the owner role confers — its entry list **and** the project
        // authority supplied by a global admin binding — without holding an owner binding itself:
        // only such a caller gets past escalation and reaches the owner lock.
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
        store.bind(USER('grantor-2'), 'admin', null);
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
