import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiExtraModels, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { JsonResponse } from '@nathapp/nestjs-common';
import { Requires } from '../../permissions/requires.decorator';
import { RequiresGuard } from '../../permissions/requires.guard';
import { FleetDashboardService } from './dashboard.service';
import { AttentionReasonDto, FleetDashboardDto, RunnerConditionDto } from './dto/fleet-dashboard.dto';

/**
 * Fleet S2b (c) §1.1: fleet health across every project, migrated onto permission keys by permissions
 * P1d (US-008). The key is checked with no project, so only a global grant passes — which is what
 * `@RequiredPermission('ADMIN')` meant here.
 */
@ApiTags('fleet')
@ApiBearerAuth()
@ApiExtraModels(AttentionReasonDto, RunnerConditionDto)
@Controller('fleet/dashboard')
export class FleetDashboardController {
  constructor(private readonly dashboard: FleetDashboardService) {}

  @Get()
  @UseGuards(RequiresGuard)
  @Requires('fleet.dashboard.read')
  @ApiOperation({ summary: 'Fleet health across every project: runners, active and recent jobs, attention items (fleet.dashboard.read, global)' })
  @ApiResponse({ status: 200, type: FleetDashboardDto })
  @ApiResponse({ status: 403, description: 'fleet.dashboard.read is missing globally' })
  async get() {
    return JsonResponse.Ok(await this.dashboard.snapshot({ kind: 'global' }, new Date()));
  }
}
