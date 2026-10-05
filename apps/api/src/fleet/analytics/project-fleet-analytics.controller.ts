import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Principal } from '@nathapp/nestjs-auth';
import { ForbiddenAppException, JsonResponse } from '@nathapp/nestjs-common';
import { parseQuery } from '../../common/dto/koda-page.query';
import { isUserPrincipal, KodaPrincipal } from '../../auth/principal/koda-principal.types';
import { CurrentProject } from '../../projects/current-project.decorator';
import type { ProjectContext } from '../../projects/project-context';
import { ProjectMembershipGuard } from '../../projects/project-membership.guard';
import { AnalyticsService } from './analytics.service';
import { AnalyticsBucketQuery, JobsQuery, SpendQuery, StoriesQuery } from './dto/analytics-query.dto';
import { JobAnalyticsDto, JobsAnalyticsDto, QualityAnalyticsDto, SpendAnalyticsDto, StoriesAnalyticsDto } from './dto/analytics-response.dto';

/** Analytics are for people; agent keys get 403, like the jobs and logs controllers. */
function assertUser(principal: KodaPrincipal): void {
  if (!isUserPrincipal(principal)) throw new ForbiddenAppException({}, 'projects');
}

/** Fleet S2b (d) §4.2: any project member. */
@ApiTags('fleet')
@ApiBearerAuth()
@ApiParam({ name: 'slug', required: true, schema: { type: 'string' } })
@Controller('projects/:slug/fleet')
@UseGuards(ProjectMembershipGuard)
export class ProjectFleetAnalyticsController {
  constructor(private readonly analytics: AnalyticsService) {}

  @Get('analytics/spend')
  @ApiOperation({ summary: 'Fleet spend over a window, bucketed and grouped (project member, S2b §4.2)' })
  @ApiResponse({ status: 200, type: SpendAnalyticsDto })
  @ApiResponse({ status: 400, description: 'Invalid window, bucket or groupBy' })
  async spend(@Query() raw: SpendQuery, @CurrentProject() ctx: ProjectContext, @Principal() principal: KodaPrincipal) {
    assertUser(principal);
    return JsonResponse.Ok(await this.analytics.spend(ctx.project.id, parseQuery(SpendQuery, raw), new Date()));
  }

  @Get('analytics/quality')
  @ApiOperation({ summary: 'Run quality over a window: first pass, attempts, reviews, finish outcomes (project member)' })
  @ApiResponse({ status: 200, type: QualityAnalyticsDto })
  @ApiResponse({ status: 400, description: 'Invalid window or bucket' })
  async quality(@Query() raw: AnalyticsBucketQuery, @CurrentProject() ctx: ProjectContext, @Principal() principal: KodaPrincipal) {
    assertUser(principal);
    return JsonResponse.Ok(await this.analytics.quality(ctx.project.id, parseQuery(AnalyticsBucketQuery, raw), new Date()));
  }

  @Get('analytics/stories')
  @ApiOperation({ summary: 'The most expensive or most looping stories in a window (project member)' })
  @ApiResponse({ status: 200, type: StoriesAnalyticsDto })
  @ApiResponse({ status: 400, description: 'Invalid window, sort or limit' })
  async stories(@Query() raw: StoriesQuery, @CurrentProject() ctx: ProjectContext, @Principal() principal: KodaPrincipal) {
    assertUser(principal);
    return JsonResponse.Ok(await this.analytics.stories(ctx.project.id, parseQuery(StoriesQuery, raw), new Date()));
  }

  @Get('analytics/jobs')
  @ApiOperation({ summary: 'The most expensive jobs finished in a window, with ledger drift (project member)' })
  @ApiResponse({ status: 200, type: JobsAnalyticsDto })
  @ApiResponse({ status: 400, description: 'Invalid window, sort or limit' })
  async jobs(@Query() raw: JobsQuery, @CurrentProject() ctx: ProjectContext, @Principal() principal: KodaPrincipal) {
    assertUser(principal);
    return JsonResponse.Ok(await this.analytics.jobs(ctx.project.id, parseQuery(JobsQuery, raw), new Date()));
  }

  @Get('jobs/:id/analytics')
  @ApiOperation({ summary: "One job's cost and quality breakdown across its attempts (project member)" })
  @ApiResponse({ status: 200, type: JobAnalyticsDto })
  @ApiResponse({ status: 404, description: 'No such job in this project' })
  async job(@Param('id') id: string, @CurrentProject() ctx: ProjectContext, @Principal() principal: KodaPrincipal) {
    assertUser(principal);
    return JsonResponse.Ok(await this.analytics.job(ctx.project.id, id));
  }
}
