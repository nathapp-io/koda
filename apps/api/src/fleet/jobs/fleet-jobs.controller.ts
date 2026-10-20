import { Body, Controller, Get, HttpCode, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Principal } from '@nathapp/nestjs-auth';
import { JsonResponse } from '@nathapp/nestjs-common';
import { KodaPageQuery, parseQuery, toPageResult } from '../../common/dto/koda-page.query';
import type { KodaPrincipal } from '../../auth/principal/koda-principal.types';
import { PermissionService } from '../../permissions/permission.service';
import { Requires } from '../../permissions/requires.decorator';
import { RequiresGuard } from '../../permissions/requires.guard';
import { ProjectMembershipGuard } from '../../projects/project-membership.guard';
import { CurrentProject } from '../../projects/current-project.decorator';
import type { ProjectContext } from '../../projects/project-context';
import { FleetJobsService } from './fleet-jobs.service';
import { DispatchFleetJobDto } from './dto/dispatch-fleet-job.dto';
import { DispatchResultDto, FleetJobDto } from './dto/fleet-job.dto';
import { ListFleetJobsQuery } from './dto/list-fleet-jobs.query';

@ApiTags('fleet')
@ApiBearerAuth()
@ApiParam({ name: 'slug', required: true, schema: { type: 'string' } })
@Controller('projects/:slug/fleet/jobs')
// Permissions P1d (US-003): every route declares `ProjectMembershipGuard, RequiresGuard` in one
// `@UseGuards`, so the membership guard resolves `request.projectContext` before the key check and
// runs exactly once per request. A class-level membership guard would run it a second time, and a
// class-level key would apply the wrong key to the routes.
export class FleetJobsController {
  constructor(
    private readonly jobs: FleetJobsService,
    private readonly permissions: PermissionService,
  ) {}

  @Post()
  @HttpCode(201)
  @UseGuards(ProjectMembershipGuard, RequiresGuard)
  @Requires('fleet.job.dispatch')
  @ApiOperation({ summary: 'Dispatch a nax run or plan to a fleet runner (fleet.job.dispatch)' })
  @ApiResponse({ status: 201, type: DispatchResultDto })
  @ApiResponse({ status: 403, description: 'fleet.job.dispatch is missing' })
  @ApiResponse({ status: 404, description: 'Repo not in this project, or pinned runner unknown' })
  @ApiResponse({ status: 409, description: 'An active job already runs this (repo, feature), or a budget covering the job is paused (fleet.budgetPaused)' })
  @ApiResponse({ status: 422, description: 'Pinned runner can never run this job' })
  async dispatch(@Body() dto: DispatchFleetJobDto, @CurrentProject() ctx: ProjectContext, @Principal() principal: KodaPrincipal) {
    return JsonResponse.Ok(await this.jobs.dispatch(principal.id, ctx.project.id, dto, { ticketActor: { principal, projectSlug: ctx.project.slug } }));
  }

  @Post(':id/cancel')
  @HttpCode(200)
  @UseGuards(ProjectMembershipGuard, RequiresGuard)
  // Permissions P1d (US-003): the requester may always cancel its own job, so the key is checked here
  // (after the service's row lookup, which keeps the 404s) and the service decides on ownership.
  @Requires('fleet.job.cancel', { enforcedBy: 'service' })
  @ApiOperation({ summary: 'Cancel a job (fleet.job.cancel, or the requester)' })
  @ApiResponse({ status: 200, type: FleetJobDto })
  @ApiResponse({ status: 403, description: 'The caller neither holds fleet.job.cancel nor requested the job' })
  @ApiResponse({ status: 409, description: 'Job already finished' })
  async cancel(@Param('id') id: string, @CurrentProject() ctx: ProjectContext, @Principal() principal: KodaPrincipal) {
    const canOperate = (await this.permissions.can(principal, 'fleet.job.cancel', { projectId: ctx.project.id })).allowed;
    return JsonResponse.Ok(await this.jobs.cancel(principal.id, ctx.project.id, id, canOperate));
  }

  @Post(':id/requeue')
  @HttpCode(200)
  @UseGuards(ProjectMembershipGuard, RequiresGuard)
  @Requires('fleet.job.requeue')
  @ApiOperation({ summary: 'Requeue a CRASHED, FAILED or CANCELLED job (fleet.job.requeue)' })
  @ApiResponse({ status: 200, type: DispatchResultDto })
  @ApiResponse({ status: 403, description: 'fleet.job.requeue is missing' })
  @ApiResponse({ status: 409, description: 'Job not requeueable, an active duplicate exists, or a budget covering the job is paused' })
  async requeue(@Param('id') id: string, @CurrentProject() ctx: ProjectContext, @Principal() principal: KodaPrincipal) {
    return JsonResponse.Ok(await this.jobs.requeue(principal.id, ctx.project.id, id));
  }

  @Get()
  @UseGuards(ProjectMembershipGuard, RequiresGuard)
  @Requires('fleet.job.read')
  @ApiOperation({ summary: 'List fleet jobs (fleet.job.read)' })
  @ApiResponse({ status: 200, description: 'Page of FleetJobDto' })
  @ApiResponse({ status: 403, description: 'fleet.job.read is missing' })
  async list(@Query() rawQuery: ListFleetJobsQuery, @CurrentProject() ctx: ProjectContext) {
    const { current, size, state, repoId, runnerId, requestedById, feature, scheduleId } = parseQuery(ListFleetJobsQuery, rawQuery);
    return JsonResponse.Ok(toPageResult(await this.jobs.list({ projectId: ctx.project.id, state, repoId, runnerId, requestedById, feature, scheduleId }, { current, size })));
  }

  @Get(':id')
  @UseGuards(ProjectMembershipGuard, RequiresGuard)
  @Requires('fleet.job.read')
  @ApiOperation({ summary: 'Get a fleet job (fleet.job.read)' })
  @ApiResponse({ status: 200, type: FleetJobDto })
  @ApiResponse({ status: 403, description: 'fleet.job.read is missing' })
  async get(@Param('id') id: string, @CurrentProject() ctx: ProjectContext) {
    return JsonResponse.Ok(await this.jobs.get(ctx.project.id, id));
  }

  @Get(':id/events')
  @UseGuards(ProjectMembershipGuard, RequiresGuard)
  @Requires('fleet.job.read')
  @ApiOperation({ summary: 'Job timeline, ordered by seq (fleet.job.read)' })
  @ApiResponse({ status: 200, description: 'Page of FleetJobEventDto' })
  @ApiResponse({ status: 403, description: 'fleet.job.read is missing' })
  async events(@Param('id') id: string, @Query() rawQuery: KodaPageQuery, @CurrentProject() ctx: ProjectContext) {
    const { current, size } = parseQuery(KodaPageQuery, rawQuery);
    return JsonResponse.Ok(toPageResult(await this.jobs.events(ctx.project.id, id, { current, size })));
  }
}
