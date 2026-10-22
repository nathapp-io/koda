import { ApiProperty } from '@nestjs/swagger';
import type {
  KeyScope,
  PermissionCatalogEntry,
  PermissionPrincipal,
  PermissionRisk,
} from '../catalog';

/** The catalog's three scopes, as the metadata route lists them. */
export const CATALOG_SCOPES: readonly KeyScope[] = ['global', 'project', 'any'];
/** The catalog's four risk levels, ascending. */
export const CATALOG_RISKS: readonly PermissionRisk[] = ['low', 'medium', 'high', 'critical'];
/** The two principal types a key can belong to. */
export const CATALOG_PRINCIPALS: readonly PermissionPrincipal[] = ['user', 'agent'];

/**
 * US-002: one role-grantable catalog key, as `GET /permissions/catalog` returns it.
 *
 * The catalog is code (`PERMISSION_CATALOG`); this DTO is the read-only projection the role editor
 * needs — scope, risk, the principal types the key serves, and whether it can be granted in its
 * `X.own` form. `access` is deliberately absent: the route lists role keys only, so every entry it
 * answers is role-grantable and the field would be a constant.
 */
export class PermissionCatalogEntryDto {
  @ApiProperty({ description: '`resource.verb[.qualifier]`', example: 'ticket.delete' })
  declare key: string;
  @ApiProperty({ enum: CATALOG_SCOPES }) declare scope: KeyScope;
  @ApiProperty({ enum: CATALOG_RISKS }) declare risk: PermissionRisk;
  @ApiProperty({ enum: CATALOG_PRINCIPALS, isArray: true }) declare principals: PermissionPrincipal[];
  @ApiProperty({ description: 'A role may grant this key in its `X.own` form' }) declare ownable: boolean;

  static from(entry: PermissionCatalogEntry): PermissionCatalogEntryDto {
    return {
      key: entry.key,
      scope: entry.scope,
      risk: entry.risk,
      principals: [...entry.principals],
      ownable: entry.ownable,
    };
  }
}
