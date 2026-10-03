import { Body, Controller, Get, HttpCode, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Principal } from '@nathapp/nestjs-auth';
import { ForbiddenAppException, JsonResponse } from '@nathapp/nestjs-common';
import { parseQuery, toPageResult } from '../../common/dto/koda-page.query';
import type { KodaPrincipal } from '../../auth/principal/koda-principal.types';
import { isUserPrincipal } from '../../auth/principal/koda-principal.types';
import { CurrentProject } from '../../projects/current-project.decorator';
import type { ProjectContext } from '../../projects/project-context';
import { ProjectMembershipGuard } from '../../projects/project-membership.guard';
import { ApprovalRoute, ApprovalsService } from './approvals.service';
import { DecideApprovalDto } from './dto/decide-approval.dto';
import { FleetApprovalDto } from './dto/fleet-approval.dto';
import { ListApprovalsQuery } from './dto/list-approvals.query';

const route = (ctx: ProjectContext): ApprovalRoute => ({ kind: 'project', projectId: ctx.project.id, role: ctx.role });

function requireUser(principal: KodaPrincipal): void {
  if (!isUserPrincipal(principal)) throw new ForbiddenAppException({}, 'projects');
}

/** S1.5 §2.3 project routes: members read; decide per §1.7 (budget asks: project ADMIN). */
@ApiTags('fleet')
@ApiBearerAuth()
@ApiParam({ name: 'slug', required: true, schema: { type: 'string' } })
@Controller('projects/:slug/fleet/approvals')
@UseGuards(ProjectMembershipGuard)
export class ProjectFleetApprovalsController {
  constructor(private readonly approvals: ApprovalsService) {}

  @Get()
  @ApiOperation({ summary: "This project's approvals, newest first (project member)" })
  @ApiResponse({ status: 200, description: 'Page of FleetApprovalDto' })
  async list(@Query() raw: ListApprovalsQuery, @CurrentProject() ctx: ProjectContext, @Principal() principal: KodaPrincipal) {
    requireUser(principal);
    const { current, size, status, type, jobId } = parseQuery(ListApprovalsQuery, raw);
    return JsonResponse.Ok(toPageResult(await this.approvals.list(route(ctx), { status, type, jobId }, { current, size })));
  }

  @Get(':id')
  @ApiOperation({ summary: 'One approval; a pending budget override includes its re-queue candidates (project member)' })
  @ApiResponse({ status: 200, type: FleetApprovalDto })
  async get(@Param('id') id: string, @CurrentProject() ctx: ProjectContext, @Principal() principal: KodaPrincipal) {
    requireUser(principal);
    return JsonResponse.Ok(await this.approvals.get(route(ctx), id));
  }

  @Post(':id/decide')
  @HttpCode(200)
  @ApiOperation({ summary: 'Decide a pending approval (budget overrides: project ADMIN)' })
  @ApiResponse({ status: 200, type: FleetApprovalDto })
  @ApiResponse({ status: 400, description: 'fleet.approvalDecisionInvalid, fleet.budgetAmountNotAboveSpend' })
  @ApiResponse({ status: 409, description: 'fleet.approvalNotPending, fleet.budgetNotPaused' })
  async decide(@Param('id') id: string, @Body() dto: DecideApprovalDto, @CurrentProject() ctx: ProjectContext, @Principal() principal: KodaPrincipal) {
    if (!isUserPrincipal(principal)) throw new ForbiddenAppException({}, 'projects');
    return JsonResponse.Ok(await this.approvals.decide({ id: principal.id, globalAdmin: principal.role === 'ADMIN' }, route(ctx), id, dto));
  }
}
