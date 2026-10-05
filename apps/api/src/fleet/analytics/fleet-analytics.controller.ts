import { Body, Controller, Delete, Get, HttpCode, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Principal, RequiredPermission } from '@nathapp/nestjs-auth';
import { JsonResponse } from '@nathapp/nestjs-common';
import { parseQuery } from '../../common/dto/koda-page.query';
import type { KodaPrincipal } from '../../auth/principal/koda-principal.types';
import { AnalyticsService } from './analytics.service';
import { AdminSpendQuery, DeleteAnalyticsBody, DeleteAnalyticsQuery } from './dto/analytics-query.dto';
import { AnalyticsDeletedDto, SpendAnalyticsDto } from './dto/analytics-response.dto';

/** Fleet S2b (d) §4.3, D370: global admin analytics. */
@ApiTags('fleet')
@ApiBearerAuth()
@Controller('fleet/analytics')
export class FleetAnalyticsController {
  constructor(private readonly analytics: AnalyticsService) {}

  @Get('spend')
  @RequiredPermission('ADMIN')
  @ApiOperation({ summary: 'Fleet spend across projects; groupBy also accepts project (global admin)' })
  @ApiResponse({ status: 200, type: SpendAnalyticsDto })
  @ApiResponse({ status: 400, description: 'Invalid window, bucket or groupBy' })
  async spend(@Query() raw: AdminSpendQuery) {
    return JsonResponse.Ok(await this.analytics.spend(null, parseQuery(AdminSpendQuery, raw), new Date()));
  }

  @Delete()
  @HttpCode(200)
  @RequiredPermission('ADMIN')
  @ApiOperation({ summary: 'Delete analytics rows dated before an instant; ingest rows are kept and marked (global admin, D384)' })
  @ApiResponse({ status: 200, type: AnalyticsDeletedDto })
  @ApiResponse({ status: 400, description: 'Missing before, or confirm is not the project slug / ALL' })
  @ApiResponse({ status: 404, description: 'No such project' })
  async remove(@Query() raw: DeleteAnalyticsQuery, @Body() body: DeleteAnalyticsBody, @Principal() principal: KodaPrincipal) {
    const q = parseQuery(DeleteAnalyticsQuery, raw);
    return JsonResponse.Ok(await this.analytics.deleteRows(principal.id, { ...q, confirm: body.confirm }, new Date()));
  }
}
