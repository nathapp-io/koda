import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { PageOption } from '@nathapp/nestjs-common';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Max, Min, ValidateIf } from 'class-validator';
import type { PrincipalType, RoleBindingView } from '../permissions.types';

/** The two kinds of principal a binding can name, in the order the catalog lists them. */
export const PRINCIPAL_TYPES: readonly PrincipalType[] = ['USER', 'AGENT'];

/** `GET /role-bindings` page size: 50 by default, 200 at most (`MembershipService` caps it again). */
export const DEFAULT_BINDING_PAGE_SIZE = 50;
export const MAX_BINDING_PAGE_SIZE = 200;

/**
 * One binding as the role-bindings API returns it: the stored row plus its role's key.
 *
 * `projectId` is null for a GLOBAL binding; a PROJECT-scope role bound with a null `projectId`
 * applies in every project.
 */
export class RoleBindingDto {
  @ApiProperty() declare id: string;
  @ApiProperty({ enum: PRINCIPAL_TYPES }) declare principalType: PrincipalType;
  @ApiProperty({ description: 'A `User.id` or an `Agent.id`; the column has no foreign key' })
  declare principalId: string;
  @ApiProperty() declare roleId: string;
  @ApiProperty({ description: 'The role\'s stable key', example: 'developer' }) declare roleKey: string;
  @ApiProperty({
    nullable: true,
    type: String,
    description: 'Null for a GLOBAL binding',
  })
  declare projectId: string | null;
  @ApiProperty({ description: 'USER, AGENT or SYSTEM' }) declare grantedByType: string;
  @ApiProperty() declare grantedById: string;
  @ApiProperty({ type: String, format: 'date-time' }) declare createdAt: Date;

  static from(binding: RoleBindingView): RoleBindingDto {
    return {
      id: binding.id,
      principalType: binding.principalType,
      principalId: binding.principalId,
      roleId: binding.roleId,
      roleKey: binding.roleKey,
      projectId: binding.projectId,
      grantedByType: binding.grantedByType,
      grantedById: binding.grantedById,
      createdAt: binding.createdAt,
    };
  }
}

/** `POST /role-bindings`: an omitted `projectId` and an explicit null both mean a global binding. */
export class CreateRoleBindingDto {
  @ApiProperty({ enum: PRINCIPAL_TYPES })
  @IsIn(PRINCIPAL_TYPES, { message: '$t(common.validation.isEnum)' })
  declare principalType: PrincipalType;

  @ApiProperty({ description: 'The user or agent the binding names' })
  @IsString({ message: '$t(common.validation.isString)' })
  declare principalId: string;

  @ApiProperty({ example: 'developer' })
  @IsString({ message: '$t(common.validation.isString)' })
  declare roleKey: string;

  @ApiPropertyOptional({ nullable: true, type: String, description: 'Omit or null for a global binding' })
  @IsOptional()
  @IsString({ message: '$t(common.validation.isString)' })
  projectId?: string | null;
}

/** True when the request names a principal at all: `principalType` and `principalId` travel together. */
function namesPrincipal(dto: ListRoleBindingsQuery): boolean {
  return dto.principalType !== undefined || dto.principalId !== undefined;
}

/**
 * `GET /role-bindings` query: the filter (`principalType` + `principalId`, `projectId`) and the page.
 *
 * The page defaults differ from `KodaPageQuery`: bindings are an administration listing, so it starts
 * at 50 and allows up to 200. A lone `principalType` or `principalId` is refused: a half-specified
 * principal would silently widen the filter to every principal.
 */
export class ListRoleBindingsQuery extends PageOption {
  @ApiPropertyOptional({ description: 'Page number (1-based)', default: 1, minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  current: number = 1;

  @ApiPropertyOptional({
    description: 'Page size',
    default: DEFAULT_BINDING_PAGE_SIZE,
    minimum: 1,
    maximum: MAX_BINDING_PAGE_SIZE,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_BINDING_PAGE_SIZE)
  size: number = DEFAULT_BINDING_PAGE_SIZE;

  @ApiPropertyOptional({ enum: PRINCIPAL_TYPES, description: 'Requires principalId' })
  @ValidateIf(namesPrincipal)
  @IsIn(PRINCIPAL_TYPES, { message: '$t(common.validation.isEnum)' })
  principalType?: PrincipalType;

  @ApiPropertyOptional({ description: 'Requires principalType' })
  @ValidateIf(namesPrincipal)
  @IsString({ message: '$t(common.validation.isString)' })
  principalId?: string;

  @ApiPropertyOptional({ description: 'Only bindings of this project; omit to list every project' })
  @IsOptional()
  @IsString({ message: '$t(common.validation.isString)' })
  projectId?: string;
}
