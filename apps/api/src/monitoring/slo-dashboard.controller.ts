import { Controller, Get, HttpCode, HttpStatus, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard, RequiredPermission } from '@nathapp/nestjs-auth';
import { JsonResponse } from '@nathapp/nestjs-common';
import { SloDashboardService, SloMetrics } from './slo-dashboard.service';

@ApiTags('admin')
@ApiBearerAuth()
@Controller('admin')
@UseGuards(JwtAuthGuard)
export class SloDashboardController {
  constructor(private readonly sloDashboardService: SloDashboardService) {}

  @Get('slos')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Get SLO dashboard metrics for a time window' })
  @ApiResponse({ status: 200, description: 'SLO metrics computed' })
  @ApiResponse({ status: 403, description: 'Forbidden - requires admin role' })
  @RequiredPermission('ADMIN')
  async getSloMetrics(
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    const now = new Date();
    const fromDate = this.parseOptionalDate(from, new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000));
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
