import { Body, Controller, Delete, Get, HttpCode, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { JsonResponse } from '@nathapp/nestjs-common';
import { ApprovalGated } from '../../approvals/route/approval-gated.decorator';
import { ApprovalPending } from '../../approvals/route/approval-pending';
import { ApprovalRouteGate } from '../../approvals/route/approval-route-gate';
import { ANALYTICS_ROUTE_VARIANTS } from './analytics-route.commands';
import { parseQuery } from '../../common/dto/koda-page.query';
import { Requires } from '../../permissions/requires.decorator';
import { RequiresGuard } from '../../permissions/requires.guard';
import { AnalyticsService } from './analytics.service';
import { AdminSpendQuery, DeleteAnalyticsBody, DeleteAnalyticsQuery } from './dto/analytics-query.dto';
import { AnalyticsDeletedDto, SpendAnalyticsDto } from './dto/analytics-response.dto';

/**
 * Fleet S2b (d) §4.3, D370: analytics across every project, migrated onto permission keys by
 * permissions P1d (US-008). Both routes are checked with no project, so only a caller holding the key
 * globally passes — which is what `@RequiredPermission('ADMIN')` meant here.
 */
@ApiTags('fleet')
@ApiBearerAuth()
@Controller('fleet/analytics')
export class FleetAnalyticsController {
  constructor(
    private readonly analytics: AnalyticsService,
    private readonly routeGate: ApprovalRouteGate,
  ) {}

  @Get('spend')
  @UseGuards(RequiresGuard)
  @Requires('fleet.analytics.read')
  @ApiOperation({ summary: 'Fleet spend across projects; groupBy also accepts project (fleet.analytics.read, global)' })
  @ApiResponse({ status: 200, type: SpendAnalyticsDto })
  @ApiResponse({ status: 400, description: 'Invalid window, bucket or groupBy' })
  @ApiResponse({ status: 403, description: 'fleet.analytics.read is missing globally' })
  async spend(@Query() raw: AdminSpendQuery) {
    return JsonResponse.Ok(await this.analytics.spend(null, parseQuery(AdminSpendQuery, raw), new Date()));
  }

  @Delete()
  @HttpCode(200)
  @UseGuards(RequiresGuard)
  @Requires('fleet.analytics.delete')
  @ApprovalGated()
  @ApiOperation({ summary: 'Delete analytics rows dated before an instant; ingest rows are kept and marked (fleet.analytics.delete, global, D384)' })
  @ApiResponse({ status: 200, type: AnalyticsDeletedDto })
  @ApiResponse({ status: 400, description: 'Missing before, or confirm is not the project slug / ALL' })
  @ApiResponse({ status: 403, description: 'fleet.analytics.delete is missing globally' })
  @ApiResponse({ status: 404, description: 'No such project' })
  async remove(@Query() raw: DeleteAnalyticsQuery, @Body() body: DeleteAnalyticsBody) {
    const q = parseQuery(DeleteAnalyticsQuery, raw);
    const outcome = await this.routeGate.run<AnalyticsDeletedDto>({
      key: 'fleet.analytics.delete',
      variant: ANALYTICS_ROUTE_VARIANTS.delete,
      projectId: null,
      input: { ...q, confirm: body.confirm },
    });
    if (outcome.status === 'pending') throw new ApprovalPending(outcome.request);
    return JsonResponse.Ok(outcome.result);
  }
}
