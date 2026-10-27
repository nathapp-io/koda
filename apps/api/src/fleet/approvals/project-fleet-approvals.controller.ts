import { Body, Controller, Get, HttpCode, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Principal } from '@nathapp/nestjs-auth';
import { JsonResponse } from '@nathapp/nestjs-common';
import { parseQuery, toPageResult } from '../../common/dto/koda-page.query';
import type { KodaPrincipal } from '../../auth/principal/koda-principal.types';
import { Requires } from '../../permissions/requires.decorator';
import { RequiresGuard } from '../../permissions/requires.guard';
import { CurrentProject } from '../../projects/current-project.decorator';
import type { ProjectContext } from '../../projects/project-context';
import { ProjectMembershipGuard } from '../../projects/project-membership.guard';
import { ApprovalRoute, ApprovalsService } from './approvals.service';
import { DecideApprovalDto } from './dto/decide-approval.dto';
import { FleetApprovalDto } from './dto/fleet-approval.dto';
import { ListApprovalsQuery } from './dto/list-approvals.query';

const route = (ctx: ProjectContext): ApprovalRoute => ({ kind: 'project', projectId: ctx.project.id });

/**
 * S1.5 §2.3 project routes, migrated onto permission keys by permissions P1d (US-006): a member reads
 * with `fleet.approval.read`; the decide route declares both type keys as metadata only, because
 * `ApprovalsService.decide` picks the one its approval's type needs after the row is loaded.
 *
 * Every route declares `ProjectMembershipGuard, RequiresGuard` in one `@UseGuards`, so the membership
 * guard resolves `request.projectContext` before the key check and runs exactly once per request.
 */
@ApiTags('fleet')
@ApiBearerAuth()
@ApiParam({ name: 'slug', required: true, schema: { type: 'string' } })
@Controller('projects/:slug/fleet/approvals')
export class ProjectFleetApprovalsController {
  constructor(private readonly approvals: ApprovalsService) {}

  @Get()
  @UseGuards(ProjectMembershipGuard, RequiresGuard)
  @Requires('fleet.approval.read')
  @ApiOperation({ summary: "This project's approvals, newest first (fleet.approval.read)" })
  @ApiResponse({ status: 200, description: 'Page of FleetApprovalDto' })
  @ApiResponse({ status: 403, description: 'fleet.approval.read is missing' })
  async list(@Query() raw: ListApprovalsQuery, @CurrentProject() ctx: ProjectContext) {
    const { current, size, status, type, jobId } = parseQuery(ListApprovalsQuery, raw);
    return JsonResponse.Ok(toPageResult(await this.approvals.list(route(ctx), { status, type, jobId }, { current, size })));
  }

  @Get(':id')
  @UseGuards(ProjectMembershipGuard, RequiresGuard)
  @Requires('fleet.approval.read')
  @ApiOperation({ summary: 'One approval; a pending budget override includes its re-queue candidates (fleet.approval.read)' })
  @ApiResponse({ status: 200, type: FleetApprovalDto })
  @ApiResponse({ status: 403, description: 'fleet.approval.read is missing' })
  @ApiResponse({ status: 404, description: 'fleet.approvals: no such approval in this project' })
  async get(@Param('id') id: string, @CurrentProject() ctx: ProjectContext) {
    return JsonResponse.Ok(await this.approvals.get(route(ctx), id));
  }

  @Post(':id/decide')
  @HttpCode(200)
  @UseGuards(ProjectMembershipGuard, RequiresGuard)
  @Requires(['fleet.approval.decide.bash', 'fleet.approval.decide.budget'], { mode: 'any', enforcedBy: 'service' })
  @ApiOperation({ summary: 'Decide a pending approval (the key of its type: fleet.approval.decide.bash or .budget)' })
  @ApiResponse({ status: 200, type: FleetApprovalDto })
  @ApiResponse({ status: 400, description: 'fleet.approvalDecisionInvalid, fleet.budgetAmountNotAboveSpend' })
  @ApiResponse({ status: 403, description: "The type's decide key is missing, fleet.approvalSelfDecide, or threads.notCreator" })
  @ApiResponse({ status: 404, description: 'fleet.approvals: no such approval in this project' })
  @ApiResponse({ status: 409, description: 'fleet.approvalNotPending, fleet.budgetNotPaused' })
  async decide(@Param('id') id: string, @Body() dto: DecideApprovalDto, @CurrentProject() ctx: ProjectContext, @Principal() principal: KodaPrincipal) {
    return JsonResponse.Ok(await this.approvals.decide({ id: principal.id, principal }, route(ctx), id, dto));
  }
}
