import { ApiProperty } from '@nestjs/swagger';
import type { MemberBinding } from '../domain/project-member.domain';

/**
 * One role chip of a project member (US-003): a role the principal holds in this project.
 *
 * `id` is the `RoleBinding` row a client edits — every chip is a binding (Permissions P1l US-006).
 * `roleName` is the role's display name, so a client renders the chip without a role lookup.
 */
export class MemberBindingDto {
  @ApiProperty({ type: String, description: 'The role binding row this chip is' })
  declare id: string;

  @ApiProperty({ example: 'developer' }) declare roleKey: string;

  @ApiProperty({ example: 'Developer' }) declare roleName: string;

  static from(binding: MemberBinding): MemberBindingDto {
    return { id: binding.id, roleKey: binding.roleKey, roleName: binding.roleName };
  }
}
