import { Controller, Get, Param, Query, StreamableFile, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiProduces, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nathapp/nestjs-throttler';
import { JsonResponse } from '@nathapp/nestjs-common';
import { parseQuery } from '../../common/dto/koda-page.query';
import { CurrentProject } from '../../projects/current-project.decorator';
import type { ProjectContext } from '../../projects/project-context';
import { ProjectMembershipGuard } from '../../projects/project-membership.guard';
import { Requires } from '../../permissions/requires.decorator';
import { RequiresGuard } from '../../permissions/requires.guard';
import { FleetJobLogEntriesDto, FleetJobLogListDto } from './dto/fleet-job-log.dto';
import { ENTRIES_DEFAULT_LIMIT, LogEntriesQuery } from './dto/log-entries.query';
import { LogRawQuery } from './dto/log-raw.query';
import { LogReadService } from './log-read.service';

/**
 * Permissions P1d (US-004): every route declares `ProjectMembershipGuard, RequiresGuard` in one
 * `@UseGuards`, so membership resolves `request.projectContext` before the key check. R10 is retired:
 * the controller no longer refuses a principal by type — a rostered agent holds `fleet.job.logs.read`
 * like a user, and the key decides. The class-level read throttle (600 requests per minute, per
 * client IP and route, D331) is untouched.
 */
@ApiTags('fleet')
@ApiBearerAuth()
@ApiParam({ name: 'slug', required: true, schema: { type: 'string' } })
@Controller('projects/:slug/fleet/jobs')
@Throttle({ default: { limit: 600, ttl: 60000 } })
export class FleetJobLogsController {
  constructor(private readonly reads: LogReadService) {}

  @Get(':id/logs')
  @UseGuards(ProjectMembershipGuard, RequiresGuard)
  @Requires('fleet.job.logs.read')
  @ApiOperation({ summary: 'Log streams of every attempt of a job, latest first (fleet.job.logs.read)' })
  @ApiResponse({ status: 200, type: FleetJobLogListDto })
  @ApiResponse({ status: 403, description: 'fleet.job.logs.read is missing' })
  @ApiResponse({ status: 404, description: 'No such job in this project' })
  async list(@Param('id') id: string, @CurrentProject() ctx: ProjectContext) {
    return JsonResponse.Ok(await this.reads.list(ctx.project.id, id));
  }

  @Get(':id/logs/:stream/entries')
  @UseGuards(ProjectMembershipGuard, RequiresGuard)
  @Requires('fleet.job.logs.read')
  @ApiParam({ name: 'stream', enum: ['run', 'stdout', 'stderr'] })
  @ApiOperation({ summary: 'One page of log lines, filtered server-side within a bounded scan (fleet.job.logs.read)' })
  @ApiResponse({ status: 200, type: FleetJobLogEntriesDto })
  @ApiResponse({ status: 400, description: 'Invalid stream or query' })
  @ApiResponse({ status: 403, description: 'fleet.job.logs.read is missing' })
  @ApiResponse({ status: 404, description: 'No such job, or leaseEpoch is past the current attempt of the job' })
  @ApiResponse({ status: 410, description: 'The stream was deleted by retention' })
  async entries(
    @Param('id') id: string,
    @Param('stream') stream: string,
    @Query() rawQuery: LogEntriesQuery,
    @CurrentProject() ctx: ProjectContext,
  ) {
    const q = parseQuery(LogEntriesQuery, rawQuery);
    return JsonResponse.Ok(await this.reads.entries(ctx.project.id, id, stream, {
      ...q, direction: q.direction ?? 'forward', limit: q.limit ?? ENTRIES_DEFAULT_LIMIT,
    }));
  }

  @Get(':id/logs/:stream/raw')
  @UseGuards(ProjectMembershipGuard, RequiresGuard)
  @Requires('fleet.job.logs.read')
  @ApiParam({ name: 'stream', enum: ['run', 'stdout', 'stderr'] })
  @ApiProduces('text/plain')
  @ApiOperation({ summary: 'Raw bytes of a log stream: a range of at most 1 MiB, or download=1 for all of it (fleet.job.logs.read)' })
  @ApiResponse({ status: 200, description: 'text/plain; charset=utf-8' })
  @ApiResponse({ status: 400, description: 'Invalid stream or range' })
  @ApiResponse({ status: 403, description: 'fleet.job.logs.read is missing' })
  @ApiResponse({ status: 404, description: 'No such job or attempt, or nothing stored to download' })
  @ApiResponse({ status: 410, description: 'The stream was deleted by retention' })
  async raw(
    @Param('id') id: string,
    @Param('stream') stream: string,
    @Query() rawQuery: LogRawQuery,
    @CurrentProject() ctx: ProjectContext,
  ): Promise<StreamableFile> {
    const q = parseQuery(LogRawQuery, rawQuery);
    if (q.download === '1') {
      const d = await this.reads.download(ctx.project.id, id, stream, q.leaseEpoch);
      return new StreamableFile(d.body, {
        type: 'text/plain; charset=utf-8',
        disposition: `attachment; filename="koda-job-${d.jobId}-${d.leaseEpoch}-${d.stream}.log"`,
        length: d.sizeBytes,
      });
    }
    return new StreamableFile(await this.reads.raw(ctx.project.id, id, stream, q), { type: 'text/plain; charset=utf-8' });
  }
}
