import { Body, Controller, Delete, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Principal } from '@nathapp/nestjs-auth';
import { JsonResponse } from '@nathapp/nestjs-common';
import type { KodaPrincipal } from '../auth/principal/koda-principal.types';
import { parseQuery, toPageResult } from '../common/dto/koda-page.query';
import {
  CreateRoleBindingDto,
  ListRoleBindingsQuery,
  RoleBindingDto,
} from './dto/role-binding.dto';
import { RoleAdminService } from './role-admin.service';
import type { BindingFilter } from './permissions.types';
import { Requires } from './requires.decorator';

/**
 * Permissions P1a: the role bindings a principal holds, globally or in one project.
 *
 * Same deliberate, scoped exception to `.nax/rules/api-core.md`'s `@RequiredPermission` convention as
 * the roles routes: the legacy CASL factory knows nothing about roles or bindings, so every handler's
 * keys are checked through `RoleAdminService.assertCan`, which answers
 * `ForbiddenAppException({}, 'permissions')` when `can` denies. `RoleAdminService` owns the check
 * order (route keys, lookups, self-binding, escalation, owner lock); this controller only maps the
 * HTTP shapes onto it.
 */
@ApiTags('role-bindings')
@ApiBearerAuth()
@Controller('role-bindings')
export class RoleBindingsController {
  constructor(private readonly roles: RoleAdminService) {}

  @Get()
  @Requires('role.read', { enforcedBy: 'service' })
  @ApiOperation({ summary: 'List role bindings, optionally for one principal or one project (role.read)' })
  @ApiResponse({
    status: 200,
    description: 'Page of bindings: { total, current, size, hasNext, hasPrev, records }',
  })
  @ApiResponse({ status: 403, description: 'role.read permission required' })
  async list(@Query() rawQuery: ListRoleBindingsQuery, @Principal() principal: KodaPrincipal) {
    const { current, size, principalType, principalId, projectId } = parseQuery(
      ListRoleBindingsQuery,
      rawQuery,
    );
    const filter: BindingFilter = {
      ...(principalType !== undefined && principalId !== undefined
        ? { principal: { type: principalType, id: principalId } }
        : {}),
      // An empty `projectId` means "no project filter", not "the empty-string project".
      ...(projectId ? { projectId } : {}),
    };
    const page = await this.roles.listBindings(principal, filter, { current, size });
    return JsonResponse.Ok({
      ...toPageResult(page),
      records: page.records.map((binding) => RoleBindingDto.from(binding)),
    });
  }

  @Post()
  @Requires(['role.binding.manage', 'role.binding.global', 'role.binding.owner'], { mode: 'any', enforcedBy: 'service' })
  @HttpCode(201)
  @ApiOperation({
    summary: 'Grant a role to a principal (role.binding.global or role.binding.manage, plus role.binding.owner for the owner role)',
  })
  @ApiResponse({ status: 201, type: RoleBindingDto })
  @ApiResponse({ status: 400, description: 'A GLOBAL role with a project id, or a principal type the role cannot serve' })
  @ApiResponse({ status: 403, description: 'A missing key, a self-binding, or a grant above the caller\'s own keys' })
  @ApiResponse({ status: 404, description: 'Unknown role, project or principal' })
  async create(@Body() dto: CreateRoleBindingDto, @Principal() principal: KodaPrincipal) {
    const binding = await this.roles.createBinding(principal, dto);
    return JsonResponse.Ok(RoleBindingDto.from(binding));
  }

  @Delete(':id')
  @Requires(['role.binding.manage', 'role.binding.global', 'role.binding.owner'], { mode: 'any', enforcedBy: 'service' })
  @HttpCode(204)
  @ApiOperation({
    summary: 'Remove a binding, authorised from the stored row (role.binding.global or role.binding.manage, plus role.binding.owner for the owner role)',
  })
  @ApiResponse({ status: 204, description: 'Removed' })
  @ApiResponse({
    status: 403,
    description: 'A missing key, a self-binding, a grant above the caller\'s own keys, or the last owner',
  })
  @ApiResponse({ status: 404, description: 'Binding not found' })
  async remove(@Param('id') id: string, @Principal() principal: KodaPrincipal) {
    await this.roles.removeBinding(principal, id);
  }
}
