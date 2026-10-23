import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import type { TransformFnParams } from 'class-transformer';
import { IsEmail, Matches, MaxLength, ValidateIf } from 'class-validator';
import { ROLE_KEY_PATTERN } from '../../../permissions/dto/role.dto';

/** A padded address (' New@X.io ') is normalised before @IsEmail runs; the service lowercases it. */
const trimmed = ({ value }: TransformFnParams): unknown => (typeof value === 'string' ? value.trim() : value);

/**
 * Fleet S4b US-004: body of `POST /projects/:slug/invites`.
 *
 * Permissions P1l (US-004): `roleKey` is the only way to name the granted role; the legacy `role` field
 * is gone and the global ValidationPipe strips it, so an invite that still sends it answers 400
 * `invites.roleRequired` from the service. Absent is allowed at the DTO; an explicit `null` is not
 * (`@IsOptional` would skip it), so it fails the key check below.
 */
export class CreateInviteDto {
  @ApiProperty({ description: 'Email to add or invite', example: 'dev@example.com' })
  @Transform(trimmed)
  @IsEmail({}, { message: '$t(common.validation.isEmail)' })
  @MaxLength(254)
  declare email: string;

  @ApiPropertyOptional({ example: 'triager', description: 'kebab-case role key; required by the service' })
  @ValidateIf((dto: CreateInviteDto) => dto.roleKey !== undefined)
  @Matches(ROLE_KEY_PATTERN, { message: '$t(common.validation.keyFormat)' })
  declare roleKey?: string;
}
