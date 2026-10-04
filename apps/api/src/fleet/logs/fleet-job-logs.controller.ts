import { Controller, Get, Param, Query, StreamableFile, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiProduces, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Principal } from '@nathapp/nestjs-auth';
import { ForbiddenAppException, JsonResponse } from '@nathapp/nestjs-common';
import { Throttle } from '@nathapp/nestjs-throttler';
import { parseQuery } from '../../common/dto/koda-page.query';
import { isUserPrincipal, KodaPrincipal } from '../../auth/principal/koda-principal.types';
import { CurrentProject } from '../../projects/current-project.decorator';
import type { ProjectContext } from '../../projects/project-context';
import { ProjectMembershipGuard } from '../../projects/project-membership.guard';
import { FleetJobLogEntriesDto, FleetJobLogListDto } from './dto/fleet-job-log.dto';
import { ENTRIES_DEFAULT_LIMIT, LogEntriesQuery } from './dto/log-entries.query';
import { LogRawQuery } from './dto/log-raw.query';
import { LogReadService } from './log-read.service';

/** R10: logs are for people; agents and runners get 403 like the jobs controller. */
function assertUser(principal: KodaPrincipal): void {
  if (!isUserPrincipal(principal)) throw new ForbiddenAppException({}, 'projects');
}

@ApiTags('fleet')
@ApiBearerAuth()
@ApiParam({ name: 'slug', required: true, schema: { type: 'string' } })
@Controller('projects/:slug/fleet/jobs')
@UseGuards(ProjectMembershipGuard)
@Throttle({ default: { limit: 600, ttl: 60000 } }) // S2a R10 / D331: per client IP, per route
export class FleetJobLogsController {
  constructor(private readonly reads: LogReadService) {}

  @Get(':id/logs')
  @ApiOperation({ summary: 'Log streams of every attempt of a job, latest first (project member, S2a §3.1)' })
  @ApiResponse({ status: 200, type: FleetJobLogListDto })
  @ApiResponse({ status: 404, description: 'No such job in this project' })
  async list(@Param('id') id: string, @CurrentProject() ctx: ProjectContext, @Principal() principal: KodaPrincipal) {
    assertUser(principal);
    return JsonResponse.Ok(await this.reads.list(ctx.project.id, id));
  }

  @Get(':id/logs/:stream/entries')
  @ApiParam({ name: 'stream', enum: ['run', 'stdout', 'stderr'] })
  @ApiOperation({ summary: 'One page of log lines, filtered server-side within a bounded scan (project member, S2a §3.3)' })
  @ApiResponse({ status: 200, type: FleetJobLogEntriesDto })
  @ApiResponse({ status: 400, description: 'Invalid stream or query' })
  @ApiResponse({ status: 404, description: 'No such job, or leaseEpoch is past the current attempt of the job' })
  @ApiResponse({ status: 410, description: 'The stream was deleted by retention' })
  async entries(
    @Param('id') id: string,
    @Param('stream') stream: string,
    @Query() rawQuery: LogEntriesQuery,
    @CurrentProject() ctx: ProjectContext,
    @Principal() principal: KodaPrincipal,
  ) {
    assertUser(principal);
    const q = parseQuery(LogEntriesQuery, rawQuery);
    return JsonResponse.Ok(await this.reads.entries(ctx.project.id, id, stream, {
      ...q, direction: q.direction ?? 'forward', limit: q.limit ?? ENTRIES_DEFAULT_LIMIT,
    }));
  }

  @Get(':id/logs/:stream/raw')
  @ApiParam({ name: 'stream', enum: ['run', 'stdout', 'stderr'] })
  @ApiProduces('text/plain')
  @ApiOperation({ summary: 'Raw bytes of a log stream: a range of at most 1 MiB, or download=1 for all of it (S2a §3.2)' })
  @ApiResponse({ status: 200, description: 'text/plain; charset=utf-8' })
  @ApiResponse({ status: 400, description: 'Invalid stream or range' })
  @ApiResponse({ status: 404, description: 'No such job or attempt, or nothing stored to download' })
  @ApiResponse({ status: 410, description: 'The stream was deleted by retention' })
  async raw(
    @Param('id') id: string,
    @Param('stream') stream: string,
    @Query() rawQuery: LogRawQuery,
    @CurrentProject() ctx: ProjectContext,
    @Principal() principal: KodaPrincipal,
  ): Promise<StreamableFile> {
    assertUser(principal);
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
