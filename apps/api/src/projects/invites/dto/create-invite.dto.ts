import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import type { TransformFnParams } from 'class-transformer';
import { IsEmail, IsIn, Matches, MaxLength, ValidateIf } from 'class-validator';
import { ROLE_KEY_PATTERN } from '../../../permissions/dto/role.dto';
import { ProjectMemberRole } from '../../members/domain/project-member.domain';
import { INVITE_ROLES } from '../domain/project-invite.domain';

/** A padded address (' New@X.io ') is normalised before @IsEmail runs; the service lowercases it. */
const trimmed = ({ value }: TransformFnParams): unknown => (typeof value === 'string' ? value.trim() : value);

/**
 * Fleet S4b US-004: body of `POST /projects/:slug/invites`.
 *
 * Permissions P1 web (US-005): `roleKey` names the role to grant and the legacy `role` stays for the CLI.
 * Both are optional here; the service requires exactly one of them.
 */
export class CreateInviteDto {
  @ApiProperty({ description: 'Email to add or invite', example: 'dev@example.com' })
  @Transform(trimmed)
  @IsEmail({}, { message: '$t(common.validation.isEmail)' })
  @MaxLength(254)
  declare email: string;

  @ApiPropertyOptional({ enum: INVITE_ROLES, description: 'Legacy role; mutually exclusive with roleKey' })
  // Absent is allowed; an explicit null is not (`@IsOptional` would skip it), so it fails the check below.
  @ValidateIf((dto: CreateInviteDto) => dto.role !== undefined)
  @IsIn(INVITE_ROLES, { message: '$t(common.validation.isEnum)' })
  declare role?: ProjectMemberRole;

  @ApiPropertyOptional({ example: 'triager', description: 'kebab-case role key; mutually exclusive with role' })
  @ValidateIf((dto: CreateInviteDto) => dto.roleKey !== undefined)
  @Matches(ROLE_KEY_PATTERN, { message: '$t(common.validation.keyFormat)' })
  declare roleKey?: string;
}
