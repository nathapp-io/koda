import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { JsonResponse } from '@nathapp/nestjs-common';
import { parseQuery } from '../../common/dto/koda-page.query';
import { CurrentProject } from '../../projects/current-project.decorator';
import type { ProjectContext } from '../../projects/project-context';
import { ProjectMembershipGuard } from '../../projects/project-membership.guard';
import { Requires } from '../../permissions/requires.decorator';
import { RequiresGuard } from '../../permissions/requires.guard';
import { AnalyticsService } from './analytics.service';
import { AnalyticsBucketQuery, AnalyticsRangeQuery, JobsQuery, SpendQuery, StoriesQuery } from './dto/analytics-query.dto';
import { IngestHealthDto, JobAnalyticsDto, JobsAnalyticsDto, QualityAnalyticsDto, SpendAnalyticsDto, StoriesAnalyticsDto } from './dto/analytics-response.dto';

/**
 * Fleet S2b (d) §4.2: the project's analytics.
 *
 * Permissions P1d (US-004): every route declares `fleet.analytics.read` — the guard replaced the
 * user-only refusal, so a rostered agent reads analytics like a user and a role without the key is
 * refused with the `permissions` code.
 */
@ApiTags('fleet')
@ApiBearerAuth()
@ApiParam({ name: 'slug', required: true, schema: { type: 'string' } })
@Controller('projects/:slug/fleet')
export class ProjectFleetAnalyticsController {
  constructor(private readonly analytics: AnalyticsService) {}

  @Get('analytics/spend')
  @UseGuards(ProjectMembershipGuard, RequiresGuard)
  @Requires('fleet.analytics.read')
  @ApiOperation({ summary: 'Fleet spend over a window, bucketed and grouped (fleet.analytics.read, S2b §4.2)' })
  @ApiResponse({ status: 200, type: SpendAnalyticsDto })
  @ApiResponse({ status: 400, description: 'Invalid window, bucket or groupBy' })
  @ApiResponse({ status: 403, description: 'fleet.analytics.read is missing' })
  async spend(@Query() raw: SpendQuery, @CurrentProject() ctx: ProjectContext) {
    return JsonResponse.Ok(await this.analytics.spend(ctx.project.id, parseQuery(SpendQuery, raw), new Date()));
  }

  @Get('analytics/quality')
  @UseGuards(ProjectMembershipGuard, RequiresGuard)
  @Requires('fleet.analytics.read')
  @ApiOperation({ summary: 'Run quality over a window: first pass, attempts, reviews, finish outcomes (fleet.analytics.read)' })
  @ApiResponse({ status: 200, type: QualityAnalyticsDto })
  @ApiResponse({ status: 400, description: 'Invalid window or bucket' })
  @ApiResponse({ status: 403, description: 'fleet.analytics.read is missing' })
  async quality(@Query() raw: AnalyticsBucketQuery, @CurrentProject() ctx: ProjectContext) {
    return JsonResponse.Ok(await this.analytics.quality(ctx.project.id, parseQuery(AnalyticsBucketQuery, raw), new Date()));
  }

  @Get('analytics/stories')
  @UseGuards(ProjectMembershipGuard, RequiresGuard)
  @Requires('fleet.analytics.read')
  @ApiOperation({ summary: 'The most expensive or most looping stories in a window (fleet.analytics.read)' })
  @ApiResponse({ status: 200, type: StoriesAnalyticsDto })
  @ApiResponse({ status: 400, description: 'Invalid window, sort or limit' })
  @ApiResponse({ status: 403, description: 'fleet.analytics.read is missing' })
  async stories(@Query() raw: StoriesQuery, @CurrentProject() ctx: ProjectContext) {
    return JsonResponse.Ok(await this.analytics.stories(ctx.project.id, parseQuery(StoriesQuery, raw), new Date()));
  }

  @Get('analytics/jobs')
  @UseGuards(ProjectMembershipGuard, RequiresGuard)
  @Requires('fleet.analytics.read')
  @ApiOperation({ summary: 'The most expensive jobs finished in a window, with ledger drift (fleet.analytics.read)' })
  @ApiResponse({ status: 200, type: JobsAnalyticsDto })
  @ApiResponse({ status: 400, description: 'Invalid window, sort or limit' })
  @ApiResponse({ status: 403, description: 'fleet.analytics.read is missing' })
  async jobs(@Query() raw: JobsQuery, @CurrentProject() ctx: ProjectContext) {
    return JsonResponse.Ok(await this.analytics.jobs(ctx.project.id, parseQuery(JobsQuery, raw), new Date()));
  }

  @Get('analytics/ingest')
  @UseGuards(ProjectMembershipGuard, RequiresGuard)
  @Requires('fleet.analytics.read')
  @ApiOperation({ summary: 'Ingest rows not yet analysed or failed, for jobs finished in a window (fleet.analytics.read, D388)' })
  @ApiResponse({ status: 200, type: IngestHealthDto })
  @ApiResponse({ status: 400, description: 'Invalid window' })
  @ApiResponse({ status: 403, description: 'fleet.analytics.read is missing' })
  async ingest(@Query() raw: AnalyticsRangeQuery, @CurrentProject() ctx: ProjectContext) {
    return JsonResponse.Ok(await this.analytics.ingestHealth(ctx.project.id, parseQuery(AnalyticsRangeQuery, raw), new Date()));
  }

  @Get('jobs/:id/analytics')
  @UseGuards(ProjectMembershipGuard, RequiresGuard)
  @Requires('fleet.analytics.read')
  @ApiOperation({ summary: "One job's cost and quality breakdown across its attempts (fleet.analytics.read)" })
  @ApiResponse({ status: 200, type: JobAnalyticsDto })
  @ApiResponse({ status: 403, description: 'fleet.analytics.read is missing' })
  @ApiResponse({ status: 404, description: 'No such job in this project' })
  async job(@Param('id') id: string, @CurrentProject() ctx: ProjectContext) {
    return JsonResponse.Ok(await this.analytics.job(ctx.project.id, id));
  }
}
