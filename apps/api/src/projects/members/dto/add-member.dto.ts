import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEmail, IsIn, IsOptional } from 'class-validator';
import { PROJECT_MEMBER_ROLES, ProjectMemberRole } from '../domain/project-member.domain';

export class AddMemberDto {
  @ApiProperty({ description: 'Email of an existing user', example: 'dev@example.com' })
  @IsEmail({}, { message: '$t(common.validation.isEmail)' })
  declare email: string;

  /**
   * S4c US-003: optional — an omitted role grants the least-privileged
   * VIEWER (the membership service supplies the default).
   */
  @ApiPropertyOptional({ enum: PROJECT_MEMBER_ROLES })
  @IsOptional()
  @IsIn(PROJECT_MEMBER_ROLES, { message: '$t(common.validation.isEnum)' })
  declare role?: ProjectMemberRole;
}
