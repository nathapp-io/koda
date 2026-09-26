import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsIn } from 'class-validator';
import { PROJECT_MEMBER_ROLES, ProjectMemberRole } from '../domain/project-member.domain';

export class AddMemberDto {
  @ApiProperty({ description: 'Email of an existing user', example: 'dev@example.com' })
  @IsEmail({}, { message: '$t(common.validation.isEmail)' })
  declare email: string;

  @ApiProperty({ enum: PROJECT_MEMBER_ROLES })
  @IsIn(PROJECT_MEMBER_ROLES, { message: '$t(common.validation.isEnum)' })
  declare role: ProjectMemberRole;
}
