import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsArray, IsIn, IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';
import type { RoleDomain, RoleScope } from '../permissions.types';

/** `key` is the role's stable identifier: kebab-case, two to forty-nine characters. */
export const ROLE_KEY_PATTERN = /^[a-z][a-z0-9-]{1,48}$/;
export const ROLE_SCOPES: readonly RoleScope[] = ['GLOBAL', 'PROJECT'];

/**
 * One role as the roles API returns it. `key` and `scope` are fixed for the life of a role, `system`
 * marks a seeded role and `locked` marks the owner role, which no write may change.
 */
export class RoleDto {
  @ApiProperty() declare id: string;
  @ApiProperty({ description: 'Stable kebab-case identifier', example: 'project-admin' }) declare key: string;
  @ApiProperty() declare name: string;
  @ApiProperty({ description: 'Empty string when the role has no description' }) declare description: string;
  @ApiProperty({ enum: ROLE_SCOPES }) declare scope: RoleScope;
  @ApiProperty({ description: 'Seeded system role' }) declare system: boolean;
  @ApiProperty({ description: 'The owner role: no write may change or delete it' }) declare locked: boolean;
  @ApiProperty({ type: [String], description: 'Catalog entries, in the order they were stored' })
  declare permissions: string[];

  static from(role: RoleDomain): RoleDto {
    return {
      id: role.id,
      key: role.key,
      name: role.name,
      description: role.description,
      scope: role.scope,
      system: role.system,
      locked: role.locked,
      permissions: role.permissions,
    };
  }
}

export class CreateRoleDto {
  @ApiProperty({ example: 'qa', description: 'kebab-case; cannot change after creation' })
  @IsString({ message: '$t(common.validation.isString)' })
  @Matches(ROLE_KEY_PATTERN, { message: '$t(common.validation.keyFormat)' })
  declare key: string;

  @ApiProperty({ example: 'QA' })
  @IsString({ message: '$t(common.validation.isString)' })
  @MinLength(1, { message: '$t(common.validation.minLength)' })
  @MaxLength(100, { message: '$t(common.validation.maxLength)' })
  declare name: string;

  @ApiPropertyOptional({ example: 'Runs the QA pass' })
  @IsOptional()
  @IsString({ message: '$t(common.validation.isString)' })
  @MaxLength(500, { message: '$t(common.validation.maxLength)' })
  description?: string;

  @ApiProperty({ enum: ROLE_SCOPES, description: 'Cannot change after creation' })
  @IsIn(ROLE_SCOPES, { message: '$t(common.validation.isEnum)' })
  declare scope: RoleScope;

  @ApiProperty({ type: [String], example: ['ticket.read', 'comment.create'] })
  @IsArray({ message: '$t(common.validation.isArray)' })
  @IsString({ each: true, message: '$t(common.validation.isString)' })
  declare permissions: string[];
}

/** `key` and `scope` are not accepted: they are fixed for the life of a role. */
export class UpdateRoleDto {
  @ApiPropertyOptional({ description: 'Rejected for a system role' })
  @IsOptional()
  @IsString({ message: '$t(common.validation.isString)' })
  @MinLength(1, { message: '$t(common.validation.minLength)' })
  @MaxLength(100, { message: '$t(common.validation.maxLength)' })
  name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString({ message: '$t(common.validation.isString)' })
  @MaxLength(500, { message: '$t(common.validation.maxLength)' })
  description?: string;

  @ApiPropertyOptional({ type: [String], description: 'Replaces the stored entry list' })
  @IsOptional()
  @IsArray({ message: '$t(common.validation.isArray)' })
  @IsString({ each: true, message: '$t(common.validation.isString)' })
  permissions?: string[];
}
