import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { JsonResponse, ValidationAppException } from '@nathapp/nestjs-common';
import { ApiBearerAuth, ApiExtraModels, ApiOperation, ApiParam, ApiResponse, ApiTags, getSchemaPath } from '@nestjs/swagger';
import { parseQuery, remapPage } from '../common/dto/koda-page.query';
import { Requires } from '../permissions/requires.decorator';
import { RequiresGuard } from '../permissions/requires.guard';
import { CurrentProject } from '../projects/current-project.decorator';
import type { ProjectContext } from '../projects/project-context';
import { ProjectMembershipGuard } from '../projects/project-membership.guard';
import { ApprovalPolicyService } from './approval-policy.service';
import { ApprovalRouteGate } from './route/approval-route-gate';
import { ApprovalPending } from './route/approval-pending';
import { ApprovalGated } from './route/approval-gated.decorator';
import { APPROVAL_ROUTE_VARIANTS } from './approval-route.commands';
import { rethrowApprovalError } from './approval-http-errors';
import { approvableKeys } from './approvable-keys';
import { ApprovalPolicyDto, ApprovableKeyDto, CreateApprovalPolicyDto, UpdateApprovalPolicyDto } from './dto/approval-policy.dto';
import { ApprovalPolicyNotFoundError } from './domain/approval.errors';
import { ListApprovalPoliciesQuery } from './dto/list-approval-policies.query';

@ApiTags('approvals')
@ApiBearerAuth()
@ApiExtraModels(ApprovalPolicyDto, ApprovableKeyDto)
@ApiParam({ name: 'slug', required: true, schema: { type: 'string' } })
@Controller('projects/:slug/approval-policies')
export class ProjectApprovalPoliciesController {
  constructor(private readonly policies: ApprovalPolicyService, private readonly routeGate: ApprovalRouteGate) {}

  @Get()
  @UseGuards(ProjectMembershipGuard, RequiresGuard)
  @Requires('approval.policy.read')
  @ApiOperation({ summary: 'List project and inherited global approval policies' })
  @ApiResponse({ status: 200, description: 'Page of project and global policies', schema: {
    type: 'object', properties: { ret: { type: 'number' }, data: {
      type: 'object', properties: {
        total: { type: 'number' }, current: { type: 'number' }, size: { type: 'number' },
        hasNext: { type: 'boolean' }, hasPrev: { type: 'boolean' },
        records: { type: 'array', items: { $ref: getSchemaPath(ApprovalPolicyDto) } },
      },
    } },
  } })
  @ApiResponse({ status: 400, description: 'Invalid query' })
  @ApiResponse({ status: 401, description: 'Missing or invalid credentials' })
  @ApiResponse({ status: 403, description: 'Project access or approval.policy.read permission required' })
  async list(@Query() rawQuery: ListApprovalPoliciesQuery, @CurrentProject() ctx: ProjectContext) {
    try {
      const { current, size, permissionPattern } = parseQuery(ListApprovalPoliciesQuery, rawQuery);
      return JsonResponse.Ok(remapPage(await this.policies.page({ projectIds: [ctx.project.id, null], permissionPattern }, { current, size }), ApprovalPolicyDto.from));
    } catch (error) { rethrowApprovalError(error); }
  }

  @Get('keys')
  @UseGuards(ProjectMembershipGuard, RequiresGuard)
  @Requires('approval.policy.read')
  @ApiOperation({ summary: 'List approvable permission keys for this project' })
  @ApiResponse({ status: 200, description: 'Approvable keys and their approval floors and defaults', schema: {
    type: 'object', properties: { ret: { type: 'number' }, data: {
      type: 'object', properties: { keys: { type: 'array', items: { $ref: getSchemaPath(ApprovableKeyDto) } } },
    } },
  } })
  @ApiResponse({ status: 401, description: 'Missing or invalid credentials' })
  @ApiResponse({ status: 403, description: 'Project access or approval.policy.read permission required' })
  keys() {
    try { return JsonResponse.Ok({ keys: approvableKeys() }); }
    catch (error) { rethrowApprovalError(error); }
  }

  @Post()
  @ApprovalGated()
  @HttpCode(201)
  @UseGuards(ProjectMembershipGuard, RequiresGuard)
  @Requires('approval.policy.manage')
  @ApiOperation({ summary: 'Create a project approval policy' })
  @ApiResponse({ status: 201, description: 'Created project policy', schema: {
    type: 'object', properties: { ret: { type: 'number' }, data: { $ref: getSchemaPath(ApprovalPolicyDto) } },
  } })
  @ApiResponse({ status: 400, description: 'Invalid approval policy' })
  @ApiResponse({ status: 401, description: 'Missing or invalid credentials' })
  @ApiResponse({ status: 403, description: 'Permission denied or self-applying agent policy' })
  @ApiResponse({ status: 409, description: 'Policy pattern and subject already exist' })
  async create(@Body() dto: CreateApprovalPolicyDto, @CurrentProject() ctx: ProjectContext) {
    try {
      const outcome = await this.routeGate.run<Awaited<ReturnType<ApprovalPolicyService['create']>>>({
        key: 'approval.policy.manage', variant: APPROVAL_ROUTE_VARIANTS.projectPolicyCreate,
        projectId: ctx.project.id, input: { projectId: ctx.project.id, policy: dto },
      });
      if (outcome.status === 'pending') throw new ApprovalPending(outcome.request);
      return JsonResponse.Ok(ApprovalPolicyDto.from(outcome.result));
    } catch (error) { rethrowApprovalError(error); }
  }

  @Patch(':id')
  @ApprovalGated()
  @UseGuards(ProjectMembershipGuard, RequiresGuard)
  @Requires('approval.policy.manage')
  @ApiOperation({ summary: 'Update a project approval policy' })
  @ApiResponse({ status: 200, description: 'Updated project policy', schema: { type: 'object', properties: { ret: { type: 'number' }, data: { $ref: getSchemaPath(ApprovalPolicyDto) } } } })
  @ApiResponse({ status: 400, description: 'Invalid or empty policy update' })
  @ApiResponse({ status: 401, description: 'Missing or invalid credentials' })
  @ApiResponse({ status: 403, description: 'Project policy management permission required' })
  @ApiResponse({ status: 404, description: 'Policy not found in this project' })
  @ApiResponse({ status: 409, description: 'Invalid policy conflict' })
  async update(@Param('id') id: string, @Body() dto: UpdateApprovalPolicyDto, @CurrentProject() ctx: ProjectContext) {
    try {
      if (!Object.values(dto).some((value) => value !== undefined)) throw new ValidationAppException({}, 'approvals.emptyPolicyPatch');
      const policy = await this.policies.get(id);
      if (policy.projectId !== ctx.project.id) throw new ApprovalPolicyNotFoundError(id);
      const outcome = await this.routeGate.run<Awaited<ReturnType<ApprovalPolicyService['update']>>>({
        key: 'approval.policy.manage', variant: APPROVAL_ROUTE_VARIANTS.projectPolicyUpdate,
        projectId: ctx.project.id, input: { projectId: ctx.project.id, id, patch: dto },
      });
      if (outcome.status === 'pending') throw new ApprovalPending(outcome.request);
      return JsonResponse.Ok(ApprovalPolicyDto.from(outcome.result));
    } catch (error) { rethrowApprovalError(error); }
  }

  @Delete(':id')
  @ApprovalGated()
  @HttpCode(204)
  @UseGuards(ProjectMembershipGuard, RequiresGuard)
  @Requires('approval.policy.manage')
  @ApiOperation({ summary: 'Delete a project approval policy' })
  @ApiResponse({ status: 204, description: 'Project policy deleted' })
  @ApiResponse({ status: 401, description: 'Missing or invalid credentials' })
  @ApiResponse({ status: 403, description: 'Project policy management permission required' })
  @ApiResponse({ status: 404, description: 'Policy not found in this project' })
  async remove(@Param('id') id: string, @CurrentProject() ctx: ProjectContext): Promise<void> {
    try {
      const policy = await this.policies.get(id);
      if (policy.projectId !== ctx.project.id) throw new ApprovalPolicyNotFoundError(id);
      const outcome = await this.routeGate.run<void>({
        key: 'approval.policy.manage', variant: APPROVAL_ROUTE_VARIANTS.projectPolicyDelete,
        projectId: ctx.project.id, input: { projectId: ctx.project.id, id },
      });
      if (outcome.status === 'pending') throw new ApprovalPending(outcome.request);
    } catch (error) { rethrowApprovalError(error); }
  }
}
