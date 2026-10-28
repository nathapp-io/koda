import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Principal } from '@nathapp/nestjs-auth';
import { JsonResponse } from '@nathapp/nestjs-common';
import { ApprovalGated } from '../approvals/route/approval-gated.decorator';
import { ApprovalPending } from '../approvals/route/approval-pending';
import { ApprovalRouteGate } from '../approvals/route/approval-route-gate';
import type { KodaPrincipal } from '../auth/principal/koda-principal.types';
import { RoleDto, CreateRoleDto, UpdateRoleDto } from './dto/role.dto';
import { PERMISSION_ROUTE_VARIANTS } from './permission-route.commands';
import type { RoleDomain } from './permissions.types';
import { RoleAdminService } from './role-admin.service';
import { Requires } from './requires.decorator';

/**
 * Permissions P1a: role administration.
 *
 * Deliberate, scoped exception to `.nax/rules/api-core.md`'s `@RequiredPermission` convention: these
 * are the first routes on the role/binding model, and the legacy CASL factory knows nothing about
 * roles or bindings. Each handler's key is checked through `RoleAdminService.assertCan`, which asks
 * `PermissionService` and answers `ForbiddenAppException({}, 'permissions')` when it denies.
 *
 * Permissions P3e-1 (US-004): the three writes are approval-gated. The handler hands its body to
 * `ApprovalRouteGate`, which refuses a caller without `role.manage` and then asks the engine; a human
 * — or a policy that needs nobody — runs the write at once, and an agent whose mode needs approval is
 * answered `202` with the pending request. The service keeps every rule it had: the gate decides
 * *whether the write may run now*, not *whether it is allowed*.
 */
@ApiTags('roles')
@ApiBearerAuth()
@Controller('roles')
export class RolesController {
  constructor(
    private readonly roles: RoleAdminService,
    private readonly routeGate: ApprovalRouteGate,
  ) {}

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
  @ApprovalGated()
  @HttpCode(201)
  @ApiOperation({ summary: 'Create a role (role.manage)' })
  @ApiResponse({ status: 201, type: RoleDto })
  @ApiResponse({ status: 400, description: 'Unknown or out-of-scope permission entry' })
  @ApiResponse({ status: 403, description: 'role.manage missing, or a grant above the caller\'s own keys' })
  @ApiResponse({ status: 409, description: 'A role with that key already exists' })
  async create(@Body() dto: CreateRoleDto) {
    const outcome = await this.routeGate.run<RoleDomain>({
      key: 'role.manage',
      variant: PERMISSION_ROUTE_VARIANTS.roleCreate,
      projectId: null,
      input: dto,
    });
    if (outcome.status === 'pending') throw new ApprovalPending(outcome.request);
    return JsonResponse.Ok(RoleDto.from(outcome.result));
  }

  @Patch(':id')
  @Requires('role.manage', { enforcedBy: 'service' })
  @ApprovalGated()
  @ApiOperation({ summary: 'Change a role\'s name, description or permissions (role.manage)' })
  @ApiResponse({ status: 200, type: RoleDto })
  @ApiResponse({ status: 400, description: 'Unknown or out-of-scope permission entry, or a system-role rename' })
  @ApiResponse({ status: 403, description: 'A grant above the caller\'s own keys, or the locked owner role' })
  @ApiResponse({ status: 404, description: 'Role not found' })
  async update(@Param('id') id: string, @Body() dto: UpdateRoleDto) {
    const outcome = await this.routeGate.run<RoleDomain>({
      key: 'role.manage',
      variant: PERMISSION_ROUTE_VARIANTS.roleUpdate,
      projectId: null,
      input: { id, patch: dto },
    });
    if (outcome.status === 'pending') throw new ApprovalPending(outcome.request);
    return JsonResponse.Ok(RoleDto.from(outcome.result));
  }

  @Delete(':id')
  @Requires('role.manage', { enforcedBy: 'service' })
  @ApprovalGated()
  @HttpCode(204)
  @ApiOperation({ summary: 'Delete a role no binding uses (role.manage)' })
  @ApiResponse({ status: 204, description: 'Deleted' })
  @ApiResponse({ status: 403, description: 'A system or locked role' })
  @ApiResponse({ status: 404, description: 'Role not found' })
  @ApiResponse({ status: 409, description: 'A binding still uses this role' })
  async remove(@Param('id') id: string) {
    const outcome = await this.routeGate.run<null>({
      key: 'role.manage',
      variant: PERMISSION_ROUTE_VARIANTS.roleDelete,
      projectId: null,
      input: { id },
    });
    if (outcome.status === 'pending') throw new ApprovalPending(outcome.request);
    return undefined;
  }
}
