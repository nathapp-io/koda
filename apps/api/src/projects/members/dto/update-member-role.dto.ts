import { ApiProperty } from '@nestjs/swagger';
import { IsIn } from 'class-validator';
import { PROJECT_MEMBER_ROLES, ProjectMemberRole } from '../domain/project-member.domain';

export class UpdateMemberRoleDto {
  @ApiProperty({ enum: PROJECT_MEMBER_ROLES })
  @IsIn(PROJECT_MEMBER_ROLES, { message: '$t(common.validation.isEnum)' })
  declare role: ProjectMemberRole;
}
