import { Body, Controller, Get, HttpCode, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { CaslPermissionAction, Principal } from '@nathapp/nestjs-auth';
import { JsonResponse, ForbiddenAppException } from '@nathapp/nestjs-common';
import { KodaPageQuery, parseQuery, toPageResult } from '../../common/dto/koda-page.query';
import type { KodaPrincipal } from '../../auth/principal/koda-principal.types';
import { isUserPrincipal } from '../../auth/principal/koda-principal.types';
import { KodaCaslAbilityFactory } from '../../auth/casl/koda-casl-ability.factory';
import { ProjectMembershipGuard } from '../../projects/project-membership.guard';
import { ProjectPermission } from '../../projects/project-permission.decorator';
import { CurrentProject } from '../../projects/current-project.decorator';
import type { ProjectContext } from '../../projects/project-context';
import { withProjectRole } from '../../projects/project-context';
import { FleetJobsService } from './fleet-jobs.service';
import { DispatchFleetJobDto } from './dto/dispatch-fleet-job.dto';
import { DispatchResultDto, FleetJobDto } from './dto/fleet-job.dto';
import { ListFleetJobsQuery } from './dto/list-fleet-jobs.query';

@ApiTags('fleet')
@ApiBearerAuth()
@Controller('projects/:slug/fleet/jobs')
@UseGuards(ProjectMembershipGuard)
export class FleetJobsController {
  constructor(
    private readonly jobs: FleetJobsService,
    private readonly casl: KodaCaslAbilityFactory,
  ) {}

  @Post()
  @HttpCode(201)
  @ProjectPermission([CaslPermissionAction.CREATE, 'FleetJob'])
  @ApiOperation({ summary: 'Dispatch a nax run or plan to a fleet runner (project DEVELOPER+)' })
  @ApiResponse({ status: 201, type: DispatchResultDto })
  @ApiResponse({ status: 404, description: 'Repo not in this project, or pinned runner unknown' })
  @ApiResponse({ status: 409, description: 'An active job already runs this (repo, feature); message names it' })
  @ApiResponse({ status: 422, description: 'Pinned runner can never run this job' })
  async dispatch(@Body() dto: DispatchFleetJobDto, @CurrentProject() ctx: ProjectContext, @Principal() principal: KodaPrincipal) {
    return JsonResponse.Ok(await this.jobs.dispatch(principal.id, ctx.project.id, dto));
  }

  @Post(':id/cancel')
  @HttpCode(200)
  @ApiOperation({ summary: 'Cancel a job (project DEVELOPER+, or the requester)' })
  @ApiResponse({ status: 200, type: FleetJobDto })
  @ApiResponse({ status: 409, description: 'Job already finished' })
  async cancel(@Param('id') id: string, @CurrentProject() ctx: ProjectContext, @Principal() principal: KodaPrincipal) {
    if (!isUserPrincipal(principal)) throw new ForbiddenAppException({}, 'projects');
    const ability = await this.casl.createForUser(withProjectRole(principal, ctx.role));
    const canOperate = ability.can(CaslPermissionAction.UPDATE, 'FleetJob');
    return JsonResponse.Ok(await this.jobs.cancel(principal.id, ctx.project.id, id, canOperate));
  }

  @Post(':id/requeue')
  @HttpCode(200)
  @ProjectPermission([CaslPermissionAction.UPDATE, 'FleetJob'])
  @ApiOperation({ summary: 'Requeue a CRASHED, FAILED or CANCELLED job (project DEVELOPER+)' })
  @ApiResponse({ status: 200, type: DispatchResultDto })
  @ApiResponse({ status: 409, description: 'Job not requeueable, or an active duplicate exists' })
  async requeue(@Param('id') id: string, @CurrentProject() ctx: ProjectContext, @Principal() principal: KodaPrincipal) {
    return JsonResponse.Ok(await this.jobs.requeue(principal.id, ctx.project.id, id));
  }

  @Get()
  @ApiOperation({ summary: 'List fleet jobs (project member)' })
  @ApiResponse({ status: 200, description: 'Page of FleetJobDto' })
  async list(@Query() rawQuery: ListFleetJobsQuery, @CurrentProject() ctx: ProjectContext) {
    const { current, size, state, repoId, runnerId, requestedById, feature } = parseQuery(ListFleetJobsQuery, rawQuery);
    return JsonResponse.Ok(toPageResult(await this.jobs.list({ projectId: ctx.project.id, state, repoId, runnerId, requestedById, feature }, { current, size })));
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a fleet job (project member)' })
  @ApiResponse({ status: 200, type: FleetJobDto })
  async get(@Param('id') id: string, @CurrentProject() ctx: ProjectContext) {
    return JsonResponse.Ok(await this.jobs.get(ctx.project.id, id));
  }

  @Get(':id/events')
  @ApiOperation({ summary: 'Job timeline, ordered by seq (project member)' })
  @ApiResponse({ status: 200, description: 'Page of FleetJobEventDto' })
  async events(@Param('id') id: string, @Query() rawQuery: KodaPageQuery, @CurrentProject() ctx: ProjectContext) {
    const { current, size } = parseQuery(KodaPageQuery, rawQuery);
    return JsonResponse.Ok(toPageResult(await this.jobs.events(ctx.project.id, id, { current, size })));
  }
}
