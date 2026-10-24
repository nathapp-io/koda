import { expandEntries } from './entry-matcher';
import { RoleAdminService } from './role-admin.service';
import type { RoleBindingView } from './permissions.types';
import type { KodaPrincipal } from '../auth/principal/koda-principal.types';

const actor: KodaPrincipal = { actorType: 'user', id: 'actor', email: 'actor@koda.test', role: 'MEMBER' };
describe('RoleAdminService binding audit callback', () => {
  it.each([
    ['viewer', 'p1', 'role.binding.manage'],
    ['custom-global', null, 'role.binding.global'],
    ['owner', null, 'role.binding.owner'],
  ])('AC-11/12: passes a callback that records the %s binding view', async (roleKey, projectId, key) => {
    const membership = { createBinding: vi.fn() };
    const audit = { record: vi.fn() };
    const permissions = { can: vi.fn().mockResolvedValue({ allowed: true }), effectiveKeys: vi.fn().mockResolvedValue(new Set([...expandEntries(['*'], 'GLOBAL'), ...expandEntries(['*'], 'PROJECT')])) };
    const service = new RoleAdminService(
      { findOne: vi.fn().mockResolvedValue({ key: roleKey, scope: projectId ? 'PROJECT' : 'GLOBAL', permissions: [] }) } as never,
      { projectExists: vi.fn().mockResolvedValue(true), principalExists: vi.fn().mockResolvedValue(true) } as never,
      permissions as never,
      {} as never, membership as never, audit as never,
    );
    await service.createBinding(actor, { principalType: 'USER', principalId: 'target', roleKey, projectId });
    const callback = membership.createBinding.mock.calls[0][2];
    expect(callback).toBeTypeOf('function');
    const view: RoleBindingView = { id: 'written-id', principalType: 'USER', principalId: 'target', roleKey, roleId: 'role', projectId, grantedByType: 'USER', grantedById: actor.id, createdAt: new Date() };
    await callback(view);
    expect(audit.record).toHaveBeenCalledExactlyOnceWith({ key, resourceType: 'role-binding', resourceId: view.id, projectId, summary: `${roleKey} to USER target` });
  });
});
