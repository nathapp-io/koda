import { Controller, Get, HttpCode, HttpStatus, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard } from '@nathapp/nestjs-auth';
import { JsonResponse } from '@nathapp/nestjs-common';
import { Requires } from '../permissions/requires.decorator';
import { RequiresGuard } from '../permissions/requires.guard';
import { SloDashboardService, SloMetrics } from './slo-dashboard.service';

// Permissions P1 (US-010): the SLO route states its GLOBAL-scope catalog key (a project-admin
// binding does not satisfy it) and keeps the JwtAuthGuard it already had.
@ApiTags('admin')
@ApiBearerAuth()
@Controller('admin')
@UseGuards(JwtAuthGuard, RequiresGuard)
export class SloDashboardController {
  constructor(private readonly sloDashboardService: SloDashboardService) {}

  @Get('slos')
  @HttpCode(HttpStatus.OK)
  @Requires('admin.slo.read')
  @ApiOperation({ summary: 'Get SLO dashboard metrics (default: the last 24 hours)' })
  @ApiResponse({ status: 200, description: 'SLO metrics computed' })
  @ApiResponse({ status: 403, description: 'Forbidden - admin.slo.read is missing' })
  async getSloMetrics(
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    const now = new Date();
    const fromDate = this.parseOptionalDate(from, new Date(now.getTime() - 24 * 60 * 60 * 1000));
    const toDate = this.parseOptionalDate(to, now);

    const metrics = await this.sloDashboardService.getSloMetrics({
      from: fromDate,
      to: toDate,
    });
    return JsonResponse.Ok(metrics);
  }

  private parseOptionalDate(value: string | undefined, fallback: Date): Date {
    if (!value) return fallback;
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) {
      return fallback;
    }
    return parsed;
  }
}
