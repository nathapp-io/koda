import { GUARDS_METADATA } from '@nestjs/common/constants';
import { ProjectRolesController } from './project-roles.controller';
import { REQUIRES_METADATA } from '../../permissions/requires.decorator';
import type { RoleDomain } from '../../permissions/permissions.types';

/**
 * US-003 — the project roles route's declaration and its mapping, without a database.
 *
 * The route's key and guard order are the contract the integration spec
 * (`test/integration/projects/project-members-principals.integration.spec.ts`) exercises over HTTP; this
 * spec pins the metadata, so a refactor that drops the key or the project gate fails without a database.
 */
describe('US-003 project roles route', () => {
  const role: RoleDomain = {
    id: 'role-1',
    key: 'developer',
    name: 'Developer',
    description: 'Builds',
    scope: 'PROJECT',
    system: true,
    locked: false,
    permissions: ['ticket.read'],
  };

  it('declares @Requires(member.read) on the list handler', () => {
    expect(Reflect.getMetadata(REQUIRES_METADATA, ProjectRolesController.prototype.list)).toEqual({
      keys: ['member.read'],
      mode: 'all',
      enforcedBy: 'guard',
    });
  });

  it('runs ProjectMembershipGuard before RequiresGuard at the class level', () => {
    const guards = (Reflect.getMetadata(GUARDS_METADATA, ProjectRolesController) ?? []) as unknown[];

    expect(guards.map((guard) => (guard as { name?: string }).name)).toEqual([
      'ProjectMembershipGuard',
      'RequiresGuard',
    ]);
  });

  it('documents the required slug path parameter on the exported operation (B3)', () => {
    // The handler has no `@Param('slug')`, so Swagger only learns the path variable from this metadata.
    // Without it `openapi.json` published an operation with no parameters and no client could send a slug.
    // A class-level `@ApiParam` copies the parameter onto each API method, so that is where it lands.
    const params = (Reflect.getMetadata('swagger/apiParameters', ProjectRolesController.prototype.list) ??
      []) as Array<Record<string, unknown>>;

    expect(params).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'slug', in: 'path', required: true }),
      ]),
    );
  });

  it('answers the five project-role fields of every role the service lists', async () => {
    const roles = { listProjectRoles: vi.fn().mockResolvedValue([role]) };
    const controller = new ProjectRolesController(roles as never);

    const res = await controller.list();

    expect(roles.listProjectRoles).toHaveBeenCalledWith();
    expect(res).toEqual({
      ret: 0,
      data: [{ id: 'role-1', key: 'developer', name: 'Developer', description: 'Builds', system: true }],
    });
  });
});
