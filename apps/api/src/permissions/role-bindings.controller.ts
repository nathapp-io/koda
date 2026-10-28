import { Body, Controller, Delete, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Principal } from '@nathapp/nestjs-auth';
import { JsonResponse, NotFoundAppException, ValidationAppException } from '@nathapp/nestjs-common';
import { ApprovalGated } from '../approvals/route/approval-gated.decorator';
import { ApprovalPending } from '../approvals/route/approval-pending';
import { ApprovalRouteGate } from '../approvals/route/approval-route-gate';
import type { KodaPrincipal } from '../auth/principal/koda-principal.types';
import { parseQuery, toPageResult } from '../common/dto/koda-page.query';
import {
  CreateRoleBindingDto,
  ListRoleBindingsQuery,
  RoleBindingDto,
} from './dto/role-binding.dto';
import { MembershipService } from './membership.service';
import { bindingGateKey, PERMISSION_ROUTE_VARIANTS } from './permission-route.commands';
import { RoleAdminService } from './role-admin.service';
import type { BindingFilter, RoleBindingView } from './permissions.types';
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
 *
 * Permissions P3e-1 (US-004): the constructor gains `MembershipService` and `ApprovalRouteGate` — the
 * delete route reads the stored binding through the first and asks the gate under the key the stored
 * row names. The two write handlers themselves are gated in US-005.
 */
@ApiTags('role-bindings')
@ApiBearerAuth()
@Controller('role-bindings')
export class RoleBindingsController {
  constructor(
    private readonly roles: RoleAdminService,
    private readonly membership: MembershipService,
    private readonly routeGate: ApprovalRouteGate,
  ) {}

  @Get()
  @Requires('role.read', { enforcedBy: 'service' })
  @ApiOperation({
    summary:
      'List role bindings, optionally for one principal, one principal type, one project or the global scope (role.read)',
  })
  @ApiResponse({
    status: 200,
    description: 'Page of bindings: { total, current, size, hasNext, hasPrev, records }',
  })
  @ApiResponse({ status: 400, description: 'A lone principalId, an unknown scope, or scope=global with a projectId' })
  @ApiResponse({ status: 403, description: 'role.read permission required' })
  async list(@Query() rawQuery: ListRoleBindingsQuery, @Principal() principal: KodaPrincipal) {
    const { current, size, principalType, principalId, projectId, scope } = parseQuery(
      ListRoleBindingsQuery,
      rawQuery,
    );
    // `scope=global` and a project id name two different listings; answering either one silently
    // would hide the caller's mistake. `permissions.scopeAndProject` is the key the client maps to
    // its own sentence.
    if (scope === 'global' && projectId) {
      throw new ValidationAppException({}, 'permissions.scopeAndProject');
    }
    const filter: BindingFilter = {
      // A type alone lists that type's bindings; with an id it narrows to the one principal.
      ...(principalType !== undefined ? { principalType } : {}),
      ...(principalType !== undefined && principalId !== undefined
        ? { principal: { type: principalType, id: principalId } }
        : {}),
      // `scope=global` is "the bindings that apply everywhere" (no project); an empty `projectId`
      // means "no project filter", not "the empty-string project".
      ...(scope === 'global' ? { projectId: null } : projectId ? { projectId } : {}),
    };
    const page = await this.roles.listBindings(principal, filter, { current, size });
    return JsonResponse.Ok({
      ...toPageResult(page),
      records: page.records.map((binding) => RoleBindingDto.from(binding)),
    });
  }

  @Post()
  @Requires(['role.binding.manage', 'role.binding.global', 'role.binding.owner'], { mode: 'any', enforcedBy: 'service' })
  @ApprovalGated()
  @HttpCode(201)
  @ApiOperation({
    summary: 'Grant a role to a principal (role.binding.global or role.binding.manage, plus role.binding.owner for the owner role)',
  })
  @ApiResponse({ status: 201, type: RoleBindingDto })
  @ApiResponse({ status: 400, description: 'A GLOBAL role with a project id, or a principal type the role cannot serve' })
  @ApiResponse({ status: 403, description: 'A missing key, a self-binding, or a grant above the caller\'s own keys' })
  @ApiResponse({ status: 404, description: 'Unknown role, project or principal' })
  @ApiResponse({ status: 202, description: 'Approval required; the binding write is pending' })
  async create(@Body() dto: CreateRoleBindingDto) {
    const projectId = dto.projectId ?? null;
    const outcome = await this.routeGate.run<RoleBindingView>({
      key: bindingGateKey({ roleKey: dto.roleKey, projectId }),
      variant: PERMISSION_ROUTE_VARIANTS.bindingCreate,
      projectId,
      input: dto,
    });
    if (outcome.status === 'pending') throw new ApprovalPending(outcome.request);
    return JsonResponse.Ok(RoleBindingDto.from(outcome.result));
  }

  @Delete(':id')
  @Requires(['role.binding.manage', 'role.binding.global', 'role.binding.owner'], { mode: 'any', enforcedBy: 'service' })
  @ApprovalGated()
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
  @ApiResponse({ status: 202, description: 'Approval required; the binding removal is pending' })
  async remove(@Param('id') id: string) {
    const binding = await this.membership.findBinding(id);
    if (!binding) throw new NotFoundAppException({}, 'permissions.bindingNotFound');
    const outcome = await this.routeGate.run<null>({
      key: bindingGateKey({ roleKey: binding.roleKey, projectId: binding.projectId }),
      variant: PERMISSION_ROUTE_VARIANTS.bindingDelete,
      projectId: binding.projectId,
      input: { id },
    });
    if (outcome.status === 'pending') throw new ApprovalPending(outcome.request);
    return undefined;
  }
}
