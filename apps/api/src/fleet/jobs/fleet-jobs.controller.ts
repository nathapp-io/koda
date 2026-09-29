import { Body, Controller, Get, HttpCode, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { CaslPermissionAction, Principal } from '@nathapp/nestjs-auth';
import { JsonResponse } from '@nathapp/nestjs-common';
import { KodaPageQuery, parseQuery, toPageResult } from '../../common/dto/koda-page.query';
import type { KodaPrincipal } from '../../auth/principal/koda-principal.types';
import { ProjectMembershipGuard } from '../../projects/project-membership.guard';
import { ProjectPermission } from '../../projects/project-permission.decorator';
import { CurrentProject } from '../../projects/current-project.decorator';
import type { ProjectContext } from '../../projects/project-context';
import { FleetJobsService } from './fleet-jobs.service';
import { DispatchFleetJobDto } from './dto/dispatch-fleet-job.dto';
import { DispatchResultDto, FleetJobDto } from './dto/fleet-job.dto';
import { ListFleetJobsQuery } from './dto/list-fleet-jobs.query';

@ApiTags('fleet')
@ApiBearerAuth()
@Controller('projects/:slug/fleet/jobs')
@UseGuards(ProjectMembershipGuard)
export class FleetJobsController {
  constructor(private readonly jobs: FleetJobsService) {}

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
