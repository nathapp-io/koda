import { mockAuditRecorder } from '../common/test-helpers/global-stubs.module';
import type { KodaPrincipal } from '../auth/principal/koda-principal.types';
import { AfterCommitService } from './after-commit.service';
import { MembershipService } from './membership.service';
import { PermissionCache } from './permission-cache';
import { PermissionService } from './permission.service';
import { RoleAdminService } from './role-admin.service';
import { FakeCacheManager, InMemoryPermissionStore } from './test-helpers/in-memory-permissions';

/**
 * Permissions P1 US-001 — the `lastProjectAdminOverride` `RoleAdminService.removeBinding` hands
 * `MembershipService`. The override is the caller's `role.binding.global`, computed only for a USER
 * `project-admin` binding inside a project; every other binding sends `false`.
 */

const USER = (id: string) => ({ type: 'USER' as const, id });
const principal = (id: string): KodaPrincipal => ({
  actorType: 'user',
  id,
  role: 'MEMBER',
  email: `${id}@koda.test`,
});

/** The transaction manager double the in-memory store expects: it runs the callback immediately. */
const txManager = {
  run: (fn: () => Promise<unknown>) => fn(),
  getClient: () => undefined,
  isInTransaction: () => false,
};

const PROJECT = 'project-alpha';

describe('RoleAdminService.removeBinding last-Project-Admin override (US-001)', () => {
  let store: InMemoryPermissionStore;
  let membership: MembershipService;
  let service: RoleAdminService;
  let removeBinding: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    store = new InMemoryPermissionStore();
    const cache = new FakeCacheManager();
    const permissionCache = new PermissionCache(cache as never);
    const permissions = new PermissionService(
      store.roleRepo() as never,
      store.bindingRepo() as never,
      permissionCache,
    );
    membership = new MembershipService(
      store.roleRepo() as never,
      store.bindingRepo() as never,
      txManager as never,
      permissionCache,
      cache as never,
      new AfterCommitService(),
    );
    // The override itself is the subject here; the guarded transaction is AC-11..AC-14's.
    removeBinding = vi.spyOn(membership, 'removeBinding').mockResolvedValue(undefined);
    service = new RoleAdminService(
      store.roleRepo() as never,
      store.bindingRepo() as never,
      permissions,
      permissionCache,
      membership,
      mockAuditRecorder,
    );

    store.projects.add(PROJECT);
    // A custom PROJECT role with every entry: the co-admin of P holds its keys but no global one.
    store.roles.push({
      id: 'role-custom-co-admin',
      key: 'custom-co-admin',
      name: 'Custom co-admin',
      description: '',
      scope: 'PROJECT',
      system: false,
      locked: false,
      permissions: ['*'],
    });
    store.addUser('global-admin');
    store.bind(USER('global-admin'), 'admin', null);
    store.addUser('co-admin');
    store.bind(USER('co-admin'), 'custom-co-admin', PROJECT);
    store.addUser('target');
  });

  it('AC-9: a caller holding a global admin binding passes lastProjectAdminOverride true', async () => {
    const binding = store.bind(USER('target'), 'project-admin', PROJECT);

    await service.removeBinding(principal('global-admin'), binding.id);

    expect(removeBinding).toHaveBeenCalledExactlyOnceWith(binding.id, { lastProjectAdminOverride: true, onWritten: expect.any(Function) });
  });

  it('AC-10: a caller holding only P\'s custom co-admin role passes lastProjectAdminOverride false', async () => {
    const binding = store.bind(USER('target'), 'project-admin', PROJECT);

    await service.removeBinding(principal('co-admin'), binding.id);

    expect(removeBinding).toHaveBeenCalledExactlyOnceWith(binding.id, { lastProjectAdminOverride: false, onWritten: expect.any(Function) });
  });

  it('never claims the override for a binding that is not a project admin\'s', async () => {
    const binding = store.bind(USER('target'), 'developer', PROJECT);

    await service.removeBinding(principal('global-admin'), binding.id);

    expect(removeBinding).toHaveBeenCalledExactlyOnceWith(binding.id, { lastProjectAdminOverride: false, onWritten: expect.any(Function) });
  });

  it('never claims the override for a project-admin binding outside a project', async () => {
    const binding = store.bind(USER('target'), 'project-admin', null);

    await service.removeBinding(principal('global-admin'), binding.id);

    expect(removeBinding).toHaveBeenCalledExactlyOnceWith(binding.id, { lastProjectAdminOverride: false, onWritten: expect.any(Function) });
  });

  it('never claims the override for an agent\'s project-admin binding', async () => {
    store.agents.add('agent-1');
    const binding = store.bind({ type: 'AGENT', id: 'agent-1' }, 'project-admin', PROJECT);

    await service.removeBinding(principal('global-admin'), binding.id);

    expect(removeBinding).toHaveBeenCalledExactlyOnceWith(binding.id, { lastProjectAdminOverride: false, onWritten: expect.any(Function) });
  });
});
