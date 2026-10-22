import { ApiProperty } from '@nestjs/swagger';
import type { RoleDomain } from '../../../permissions/permissions.types';

/**
 * One assignable project role (US-003): the PROJECT-scope roles a member can be given in a project.
 *
 * Deliberately narrower than `RoleDto`: a project admin binds an existing role, and does not need the
 * role's stored entry list (the global roles editor owns that). `system` tells a client whether the
 * role is seeded, so a custom role can be marked as such.
 */
export class ProjectRoleDto {
  @ApiProperty() declare id: string;
  @ApiProperty({ example: 'developer' }) declare key: string;
  @ApiProperty({ example: 'Developer' }) declare name: string;
  @ApiProperty({ description: 'Empty string when the role has no description' }) declare description: string;
  @ApiProperty({ description: 'Seeded system role' }) declare system: boolean;

  static from(role: RoleDomain): ProjectRoleDto {
    return {
      id: role.id,
      key: role.key,
      name: role.name,
      description: role.description,
      system: role.system,
    };
  }
}
