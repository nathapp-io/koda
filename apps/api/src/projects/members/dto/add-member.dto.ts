import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEmail, Matches, ValidateIf } from 'class-validator';
import { ROLE_KEY_PATTERN } from '../../../permissions/dto/role.dto';

/**
 * `POST /projects/:slug/members`.
 *
 * Permissions P1l (US-004): `roleKey` is the only way to name the role to grant — a seeded PROJECT role
 * or a custom one the project may hand out. The legacy `role` field is gone; the global ValidationPipe
 * strips it, so an add that still sends it grants the least-privileged `viewer` unless `roleKey` is
 * present. An absent `roleKey` keeps that `viewer` default; an explicit `null` is a validation error
 * (`@ValidateIf` runs the key check for any present value, `@IsOptional` would have skipped `null`).
 */
export class AddMemberDto {
  @ApiProperty({ description: 'Email of an existing user', example: 'dev@example.com' })
  @IsEmail({}, { message: '$t(common.validation.isEmail)' })
  declare email: string;

  /** US-004: the role key to grant; omitted means the least-privileged `viewer`. */
  @ApiPropertyOptional({ example: 'triager', description: 'kebab-case role key; omitted grants viewer' })
  @ValidateIf((dto: AddMemberDto) => dto.roleKey !== undefined)
  @Matches(ROLE_KEY_PATTERN, { message: '$t(common.validation.keyFormat)' })
  declare roleKey?: string;
}
