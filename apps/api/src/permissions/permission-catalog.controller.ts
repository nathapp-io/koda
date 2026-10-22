import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { JsonResponse } from '@nathapp/nestjs-common';
import { PERMISSION_CATALOG, type PermissionCatalogEntry } from './catalog';
import { PermissionCatalogEntryDto } from './dto/permission-catalog-entry.dto';
import { Requires } from './requires.decorator';
import { RequiresGuard } from './requires.guard';

/** `a.key` before `b.key`, by code unit: the catalog's keys are ASCII, so this is the wire order. */
function byKey(left: PermissionCatalogEntry, right: PermissionCatalogEntry): number {
  if (left.key === right.key) return 0;
  return left.key < right.key ? -1 : 1;
}

/**
 * US-002: the permission catalog as metadata — what each key is, not who holds it.
 *
 * The catalog is code (`PERMISSION_CATALOG`), so the route reads it directly instead of going through
 * a service: there is no row to own, no project to scope it to, and nothing to persist. It answers
 * the `access === 'role'` entries only — those are the keys a role can hold and the only ones the role
 * editor can offer; implicit, public, runner and system keys are not grantable and would only invite
 * clients to gate on something no role can carry.
 *
 * `role.read` gates it, as it gates `GET /roles`: whoever may read roles may read the vocabulary
 * those roles are written in. The route lives in `PermissionsModule`, so it needs no other module.
 */
@ApiTags('permissions')
@ApiBearerAuth()
@Controller('permissions')
export class PermissionCatalogController {
  @Get('catalog')
  @UseGuards(RequiresGuard)
  @Requires('role.read')
  @ApiOperation({ summary: 'The role-grantable permission keys with their scope, risk and ownability (role.read)' })
  @ApiResponse({ status: 200, type: [PermissionCatalogEntryDto], description: 'Every role key, sorted by key' })
  @ApiResponse({ status: 403, description: 'role.read permission required' })
  list() {
    const entries = PERMISSION_CATALOG.filter((entry) => entry.access === 'role')
      .sort(byKey)
      .map((entry) => PermissionCatalogEntryDto.from(entry));
    return JsonResponse.Ok(entries);
  }
}
