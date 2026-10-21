import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Principal } from '@nathapp/nestjs-auth';
import { JsonResponse } from '@nathapp/nestjs-common';
import type { KodaPrincipal } from '../auth/principal/koda-principal.types';
import { RoleDto, CreateRoleDto, UpdateRoleDto } from './dto/role.dto';
import { RoleAdminService } from './role-admin.service';
import { Requires } from './requires.decorator';

/**
 * Permissions P1a: role administration.
 *
 * Deliberate, scoped exception to `.nax/rules/api-core.md`'s `@RequiredPermission` convention: these
 * are the first routes on the role/binding model, and the legacy CASL factory knows nothing about
 * roles or bindings. Each handler's key is checked through `RoleAdminService.assertCan`, which asks
 * `PermissionService` and answers `ForbiddenAppException({}, 'permissions')` when it denies.
 */
@ApiTags('roles')
@ApiBearerAuth()
@Controller('roles')
export class RolesController {
  constructor(private readonly roles: RoleAdminService) {}

  @Get()
  @Requires('role.read', { enforcedBy: 'service' })
  @ApiOperation({ summary: 'List every role, system roles first' })
  @ApiResponse({ status: 200, type: [RoleDto] })
  @ApiResponse({ status: 403, description: 'role.read permission required' })
  async list(@Principal() principal: KodaPrincipal) {
    const roles = await this.roles.listRoles(principal);
    return JsonResponse.Ok(roles.map((role) => RoleDto.from(role)));
  }

  @Post()
  @Requires('role.manage', { enforcedBy: 'service' })
  @HttpCode(201)
  @ApiOperation({ summary: 'Create a role (role.manage)' })
  @ApiResponse({ status: 201, type: RoleDto })
  @ApiResponse({ status: 400, description: 'Unknown or out-of-scope permission entry' })
  @ApiResponse({ status: 403, description: 'role.manage missing, or a grant above the caller\'s own keys' })
  @ApiResponse({ status: 409, description: 'A role with that key already exists' })
  async create(@Body() dto: CreateRoleDto, @Principal() principal: KodaPrincipal) {
    const role = await this.roles.createRole(principal, dto);
    return JsonResponse.Ok(RoleDto.from(role));
  }

  @Patch(':id')
  @Requires('role.manage', { enforcedBy: 'service' })
  @ApiOperation({ summary: 'Change a role\'s name, description or permissions (role.manage)' })
  @ApiResponse({ status: 200, type: RoleDto })
  @ApiResponse({ status: 400, description: 'Unknown or out-of-scope permission entry, or a system-role rename' })
  @ApiResponse({ status: 403, description: 'A grant above the caller\'s own keys, or the locked owner role' })
  @ApiResponse({ status: 404, description: 'Role not found' })
  async update(
    @Param('id') id: string,
    @Body() dto: UpdateRoleDto,
    @Principal() principal: KodaPrincipal,
  ) {
    const role = await this.roles.updateRole(principal, id, dto);
    return JsonResponse.Ok(RoleDto.from(role));
  }

  @Delete(':id')
  @Requires('role.manage', { enforcedBy: 'service' })
  @HttpCode(204)
  @ApiOperation({ summary: 'Delete a role no binding uses (role.manage)' })
  @ApiResponse({ status: 204, description: 'Deleted' })
  @ApiResponse({ status: 403, description: 'A system or locked role' })
  @ApiResponse({ status: 404, description: 'Role not found' })
  @ApiResponse({ status: 409, description: 'A binding still uses this role' })
  async remove(@Param('id') id: string, @Principal() principal: KodaPrincipal) {
    await this.roles.deleteRole(principal, id);
  }
}
