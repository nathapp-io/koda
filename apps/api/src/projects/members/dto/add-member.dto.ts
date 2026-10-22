import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEmail, IsIn, IsOptional, Matches } from 'class-validator';
import { ROLE_KEY_PATTERN } from '../../../permissions/dto/role.dto';
import { PROJECT_MEMBER_ROLES, ProjectMemberRole } from '../domain/project-member.domain';

/**
 * `POST /projects/:slug/members`.
 *
 * Permissions P1 web (US-004): `roleKey` names the role to grant — a seeded PROJECT role or a custom one
 * the project may hand out — and the legacy `role` field stays for the CLI. Both are optional and at most
 * one may be sent: `roleKey` decides, else `role` maps to its role key, else the least-privileged
 * `viewer`.
 */
export class AddMemberDto {
  @ApiProperty({ description: 'Email of an existing user', example: 'dev@example.com' })
  @IsEmail({}, { message: '$t(common.validation.isEmail)' })
  declare email: string;

  /**
   * S4c US-003: optional — an omitted role grants the least-privileged
   * VIEWER (the membership service supplies the default). US-004: mutually
   * exclusive with `roleKey`.
   */
  @ApiPropertyOptional({ enum: PROJECT_MEMBER_ROLES })
  @IsOptional()
  @IsIn(PROJECT_MEMBER_ROLES, { message: '$t(common.validation.isEnum)' })
  declare role?: ProjectMemberRole;

  /** US-004: the role key to grant; takes precedence over `role` and cannot be combined with it. */
  @ApiPropertyOptional({ example: 'triager', description: 'kebab-case role key; mutually exclusive with role' })
  @IsOptional()
  @Matches(ROLE_KEY_PATTERN, { message: '$t(common.validation.keyFormat)' })
  declare roleKey?: string;
}
