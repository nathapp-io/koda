import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNotEmpty, IsOptional, IsString } from 'class-validator';

/** The two scopes `GET /me/permissions` answers for, in the order the route documents them. */
export const ME_PERMISSIONS_SCOPES = ['global', 'project'] as const;

export type MePermissionsScope = (typeof ME_PERMISSIONS_SCOPES)[number];

/**
 * `GET /me/permissions` query: the project to answer for, as a slug. Omitted means the global scope.
 *
 * An empty value (`?project=`) is a validation refusal, not "no project": the web either asks for the
 * global scope by leaving the parameter out or names a project, so an empty string is a client bug
 * worth surfacing at the boundary.
 */
export class MePermissionsQuery {
  @ApiPropertyOptional({
    description: 'Project slug; omit for the global scope',
    example: 'koda',
  })
  @IsOptional()
  @IsString({ message: '$t(common.validation.isString)' })
  @IsNotEmpty({ message: '$t(common.validation.isNotEmpty)' })
  project?: string;
}

/**
 * The caller's effective keys for one scope.
 *
 * `keys` is exactly `PermissionService.effectiveKeys` for that scope — role-derived keys and `X.own`
 * entries — sorted ascending, so a client can gate on membership of the list. Implicit keys (every
 * authenticated principal holds them) and public keys are never listed: they are always allowed by
 * the API, whatever the role model says.
 */
export class MePermissionsDto {
  @ApiProperty({ enum: ME_PERMISSIONS_SCOPES, description: 'The scope the keys are answered for' })
  declare scope: MePermissionsScope;

  @ApiProperty({
    nullable: true,
    type: String,
    description: 'The project slug of a project scope; null for the global scope',
  })
  declare projectSlug: string | null;

  @ApiProperty({ type: [String], description: 'The effective permission keys, ascending' })
  declare keys: string[];

  static of(scope: MePermissionsScope, projectSlug: string | null, keys: ReadonlySet<string>): MePermissionsDto {
    return { scope, projectSlug, keys: [...keys].sort() };
  }
}
