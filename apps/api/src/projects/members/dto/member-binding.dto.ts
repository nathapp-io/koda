import { ApiProperty } from '@nestjs/swagger';
import type { MemberBinding } from '../domain/project-member.domain';

/**
 * One role chip of a project member (US-003): a role the principal holds in this project.
 *
 * `id` is the `RoleBinding` row, or null for the entry that stands for a legacy row
 * (`ProjectMember` of `DEVELOPER`, an `AgentProject` roster row of `VIEWER`) which has no binding to
 * edit. `roleName` is the role's display name, so a client renders the chip without a role lookup.
 */
export class MemberBindingDto {
  @ApiProperty({ nullable: true, type: String, description: 'The binding row; null for a legacy membership row' })
  declare id: string | null;

  @ApiProperty({ example: 'developer' }) declare roleKey: string;

  @ApiProperty({ example: 'Developer' }) declare roleName: string;

  static from(binding: MemberBinding): MemberBindingDto {
    return { id: binding.id, roleKey: binding.roleKey, roleName: binding.roleName };
  }
}
