import { Controller, Get, Inject, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Principal } from '@nathapp/nestjs-auth';
import { JsonResponse, NotFoundAppException } from '@nathapp/nestjs-common';
import { ITransactionManager, TRANSACTION_MANAGER } from '@nathapp/nestjs-data';
import { parseQuery, remapPage, toPageResult } from '../../common/dto/koda-page.query';
import type { KodaPrincipal } from '../../auth/principal/koda-principal.types';
import { Requires } from '../../permissions/requires.decorator';
import { RequiresGuard } from '../../permissions/requires.guard';
import { FleetActivityService } from '../activity/fleet-activity.service';
import { AuditRecorder } from '../../audit/audit-recorder.service';
import { bookkeeping } from '../../action-context/audit-coverage';
import { FLEET_JOB_REPOSITORY, IFleetJobRepository } from '../jobs/domain/fleet-job.domain';
import { BundleIngestService } from './bundle-ingest.service';
import { BUNDLE_INGEST_REPOSITORY, IBundleIngestRepository, INGEST_PARSER_VERSION } from './domain/bundle-ingest.domain';
import { IngestQueuedDto, IngestRowDto } from './dto/ingest-row.dto';
import { ListIngestQuery } from './dto/list-ingest.query';

/** Fleet S2b (d) §2.6, D370: ingest health and re-runs, migrated onto permission keys by permissions P1d (US-008). */
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
    private readonly audit: AuditRecorder,
  ) {}

  @Get()
  @UseGuards(RequiresGuard)
  @Requires('fleet.ingest.read')
  @ApiOperation({ summary: 'List bundle ingest rows (fleet.ingest.read, global)' })
  @ApiResponse({ status: 200, description: 'Page of IngestRowDto' })
  @ApiResponse({ status: 403, description: 'fleet.ingest.read is missing globally' })
  async list(@Query() rawQuery: ListIngestQuery) {
    const q = parseQuery(ListIngestQuery, rawQuery);
    const page = await this.repo.findPage({ status: q.status }, { current: q.current, size: q.size });
    return JsonResponse.Ok(toPageResult(remapPage(page, IngestRowDto.from)));
  }

  @Post('backfill')
  @UseGuards(RequiresGuard)
  @Requires('fleet.ingest.backfill')
  @ApiOperation({ summary: 'Queue every unexpired bundle that has no ingest row (fleet.ingest.backfill, global)' })
  @ApiResponse({ status: 201, type: IngestQueuedDto })
  @ApiResponse({ status: 403, description: 'fleet.ingest.backfill is missing globally' })
  async backfill(@Principal() principal: KodaPrincipal) {
    return JsonResponse.Ok(await this.queue(
      principal.id, 'ingest.backfill', 'ingest', 'all', null, 'fleet.ingest.backfill', 'fleet-ingest', 'all',
      (n) => `backfill queued ${n}`, () => this.repo.backfill(INGEST_PARSER_VERSION),
    ));
  }

  @Post('jobs/:jobId/rerun')
  @UseGuards(RequiresGuard)
  @Requires('fleet.ingest.rerun')
  @ApiOperation({ summary: "Re-ingest a job's bundles (fleet.ingest.rerun, global)" })
  @ApiResponse({ status: 201, type: IngestQueuedDto })
  @ApiResponse({ status: 403, description: 'fleet.ingest.rerun is missing globally' })
  async rerunJob(@Param('jobId') jobId: string, @Principal() principal: KodaPrincipal) {
    const job = await this.jobs.findById(jobId);
    if (!job) throw new NotFoundAppException({}, 'fleet.jobs');
    return JsonResponse.Ok(await this.queue(
      principal.id, 'ingest.rerun', 'job', job.id, job.projectId, 'fleet.ingest.rerun', 'fleet-job', job.id,
      (n) => `rerun queued ${n}`, () => this.repo.rerunJob(job.id),
    ));
  }

  @Post('rerun-outdated')
  @UseGuards(RequiresGuard)
  @Requires('fleet.ingest.rerun')
  @ApiOperation({ summary: 'Re-ingest bundles ingested by an older parser version (fleet.ingest.rerun, global)' })
  @ApiResponse({ status: 201, type: IngestQueuedDto })
  @ApiResponse({ status: 403, description: 'fleet.ingest.rerun is missing globally' })
  async rerunOutdated(@Principal() principal: KodaPrincipal) {
    return JsonResponse.Ok(await this.queue(
      principal.id, 'ingest.rerun_outdated', 'ingest', 'all', null, 'fleet.ingest.rerun', 'fleet-ingest', 'all',
      (n) => `rerun outdated queued ${n}`, () => this.repo.rerunOutdated(INGEST_PARSER_VERSION),
    ));
  }

  private async queue(
    actorId: string, action: string, entityType: 'ingest' | 'job', entityId: string, projectId: string | null,
    auditKey: string, resourceType: string, resourceId: string, auditSummary: (count: number) => string, run: () => Promise<number>,
  ): Promise<{ queued: number }> {
    const queued = await this.txManager.run(async () => {
      const n = await run();
      await bookkeeping('fleet.ingest-progress', () => this.activity.record({
        actorType: 'USER', actorId, action, entityType, entityId, jobId: entityType === 'job' ? entityId : null, projectId,
        responsibleUserId: actorId, payload: { queued: n, parserVersion: INGEST_PARSER_VERSION },
      }));
      if (n > 0) {
        await this.audit.record({ key: auditKey, resourceType, resourceId, projectId, summary: auditSummary(n) });
      }
      return n;
    });
    this.ingest.kick();
    return { queued };
  }
}
