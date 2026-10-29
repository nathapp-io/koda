import { Controller, Get, Inject, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Principal } from '@nathapp/nestjs-auth';
import { JsonResponse } from '@nathapp/nestjs-common';
import { parseQuery, remapPage, toPageResult } from '../../common/dto/koda-page.query';
import type { KodaPrincipal } from '../../auth/principal/koda-principal.types';
import { Requires } from '../../permissions/requires.decorator';
import { RequiresGuard } from '../../permissions/requires.guard';
import { BUNDLE_INGEST_REPOSITORY, IBundleIngestRepository } from './domain/bundle-ingest.domain';
import { IngestQueuedDto, IngestRowDto } from './dto/ingest-row.dto';
import { ListIngestQuery } from './dto/list-ingest.query';
import { ApprovalGated } from '../../approvals/route/approval-gated.decorator';
import { ApprovalPending } from '../../approvals/route/approval-pending';
import { ApprovalRouteGate } from '../../approvals/route/approval-route-gate';
import { INGEST_ROUTE_VARIANTS } from './ingest-route.commands';

/** Fleet S2b (d) §2.6, D370: ingest health and re-runs, migrated onto permission keys by permissions P1d (US-008). */
@ApiTags('fleet')
@ApiBearerAuth()
@Controller('fleet/ingest')
export class FleetIngestController {
  constructor(
    @Inject(BUNDLE_INGEST_REPOSITORY) private readonly repo: IBundleIngestRepository,
    private readonly routeGate: ApprovalRouteGate,
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
  @ApprovalGated()
  @ApiOperation({ summary: 'Queue every unexpired bundle that has no ingest row (fleet.ingest.backfill, global)' })
  @ApiResponse({ status: 201, type: IngestQueuedDto })
  @ApiResponse({ status: 403, description: 'fleet.ingest.backfill is missing globally' })
  async backfill(@Principal() principal: KodaPrincipal) {
    const outcome = await this.routeGate.run<IngestQueuedDto>({
      key: 'fleet.ingest.backfill', variant: INGEST_ROUTE_VARIANTS.backfill, projectId: null, input: {},
    });
    if (outcome.status === 'pending') throw new ApprovalPending(outcome.request);
    return JsonResponse.Ok(outcome.result);
  }

  @Post('jobs/:jobId/rerun')
  @UseGuards(RequiresGuard)
  @Requires('fleet.ingest.rerun')
  @ApprovalGated()
  @ApiOperation({ summary: "Re-ingest a job's bundles (fleet.ingest.rerun, global)" })
  @ApiResponse({ status: 201, type: IngestQueuedDto })
  @ApiResponse({ status: 403, description: 'fleet.ingest.rerun is missing globally' })
  async rerunJob(@Param('jobId') jobId: string, @Principal() principal: KodaPrincipal) {
    const outcome = await this.routeGate.run<IngestQueuedDto>({
      key: 'fleet.ingest.rerun', variant: INGEST_ROUTE_VARIANTS.rerunJob, projectId: null, input: { jobId },
    });
    if (outcome.status === 'pending') throw new ApprovalPending(outcome.request);
    return JsonResponse.Ok(outcome.result);
  }

  @Post('rerun-outdated')
  @UseGuards(RequiresGuard)
  @Requires('fleet.ingest.rerun')
  @ApprovalGated()
  @ApiOperation({ summary: 'Re-ingest bundles ingested by an older parser version (fleet.ingest.rerun, global)' })
  @ApiResponse({ status: 201, type: IngestQueuedDto })
  @ApiResponse({ status: 403, description: 'fleet.ingest.rerun is missing globally' })
  async rerunOutdated(@Principal() principal: KodaPrincipal) {
    const outcome = await this.routeGate.run<IngestQueuedDto>({
      key: 'fleet.ingest.rerun', variant: INGEST_ROUTE_VARIANTS.rerunOutdated, projectId: null, input: {},
    });
    if (outcome.status === 'pending') throw new ApprovalPending(outcome.request);
    return JsonResponse.Ok(outcome.result);
  }
}
