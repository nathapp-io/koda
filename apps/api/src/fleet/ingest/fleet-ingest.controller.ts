import { Controller, Get, Inject, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Principal, RequiredPermission } from '@nathapp/nestjs-auth';
import { JsonResponse, NotFoundAppException } from '@nathapp/nestjs-common';
import { ITransactionManager, TRANSACTION_MANAGER } from '@nathapp/nestjs-data';
import { parseQuery, remapPage, toPageResult } from '../../common/dto/koda-page.query';
import type { KodaPrincipal } from '../../auth/principal/koda-principal.types';
import { FleetActivityService } from '../activity/fleet-activity.service';
import { FLEET_JOB_REPOSITORY, IFleetJobRepository } from '../jobs/domain/fleet-job.domain';
import { BundleIngestService } from './bundle-ingest.service';
import { BUNDLE_INGEST_REPOSITORY, IBundleIngestRepository, INGEST_PARSER_VERSION } from './domain/bundle-ingest.domain';
import { IngestQueuedDto, IngestRowDto } from './dto/ingest-row.dto';
import { ListIngestQuery } from './dto/list-ingest.query';

/** Fleet S2b (d) §2.6, D370: ingest health and re-runs (global admin). */
@ApiTags('fleet')
@ApiBearerAuth()
@Controller('fleet/ingest')
export class FleetIngestController {
  constructor(
    @Inject(BUNDLE_INGEST_REPOSITORY) private readonly repo: IBundleIngestRepository,
    @Inject(FLEET_JOB_REPOSITORY) private readonly jobs: Pick<IFleetJobRepository, 'findById'>,
    private readonly ingest: BundleIngestService,
    private readonly activity: FleetActivityService,
    @Inject(TRANSACTION_MANAGER) private readonly txManager: ITransactionManager,
  ) {}

  @Get()
  @RequiredPermission('ADMIN')
  @ApiOperation({ summary: 'List bundle ingest rows (global admin)' })
  @ApiResponse({ status: 200, description: 'Page of IngestRowDto' })
  async list(@Query() rawQuery: ListIngestQuery) {
    const q = parseQuery(ListIngestQuery, rawQuery);
    const page = await this.repo.findPage({ status: q.status }, { current: q.current, size: q.size });
    return JsonResponse.Ok(toPageResult(remapPage(page, IngestRowDto.from)));
  }

  @Post('backfill')
  @RequiredPermission('ADMIN')
  @ApiOperation({ summary: 'Queue every unexpired bundle that has no ingest row (global admin)' })
  @ApiResponse({ status: 201, type: IngestQueuedDto })
  async backfill(@Principal() principal: KodaPrincipal) {
    return JsonResponse.Ok(await this.queue(principal.id, 'ingest.backfill', 'ingest', 'all', null, () => this.repo.backfill(INGEST_PARSER_VERSION)));
  }

  @Post('jobs/:jobId/rerun')
  @RequiredPermission('ADMIN')
  @ApiOperation({ summary: "Re-ingest a job's bundles (global admin)" })
  @ApiResponse({ status: 201, type: IngestQueuedDto })
  async rerunJob(@Param('jobId') jobId: string, @Principal() principal: KodaPrincipal) {
    const job = await this.jobs.findById(jobId);
    if (!job) throw new NotFoundAppException({}, 'fleet.jobs');
    return JsonResponse.Ok(await this.queue(principal.id, 'ingest.rerun', 'job', job.id, job.projectId, () => this.repo.rerunJob(job.id)));
  }

  @Post('rerun-outdated')
  @RequiredPermission('ADMIN')
  @ApiOperation({ summary: 'Re-ingest bundles ingested by an older parser version (global admin)' })
  @ApiResponse({ status: 201, type: IngestQueuedDto })
  async rerunOutdated(@Principal() principal: KodaPrincipal) {
    return JsonResponse.Ok(await this.queue(principal.id, 'ingest.rerun_outdated', 'ingest', 'all', null, () => this.repo.rerunOutdated(INGEST_PARSER_VERSION)));
  }

  private async queue(
    actorId: string, action: string, entityType: 'ingest' | 'job', entityId: string, projectId: string | null, run: () => Promise<number>,
  ): Promise<{ queued: number }> {
    const queued = await this.txManager.run(async () => {
      const n = await run();
      await this.activity.record({
        actorType: 'USER', actorId, action, entityType, entityId, jobId: entityType === 'job' ? entityId : null, projectId,
        responsibleUserId: actorId, payload: { queued: n, parserVersion: INGEST_PARSER_VERSION },
      });
      return n;
    });
    this.ingest.kick();
    return { queued };
  }
}
