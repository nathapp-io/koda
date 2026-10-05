import { Controller, Get } from '@nestjs/common';
import { ApiBearerAuth, ApiExtraModels, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { RequiredPermission } from '@nathapp/nestjs-auth';
import { JsonResponse } from '@nathapp/nestjs-common';
import { FleetDashboardService } from './dashboard.service';
import { AttentionReasonDto, FleetDashboardDto, RunnerConditionDto } from './dto/fleet-dashboard.dto';

/** Fleet S2b (c) §1.1: fleet health across every project (global admin). */
@ApiTags('fleet')
@ApiBearerAuth()
@ApiExtraModels(AttentionReasonDto, RunnerConditionDto)
@Controller('fleet/dashboard')
export class FleetDashboardController {
  constructor(private readonly dashboard: FleetDashboardService) {}

  @Get()
  @RequiredPermission('ADMIN')
  @ApiOperation({ summary: 'Fleet health across every project: runners, active and recent jobs, attention items (global admin)' })
  @ApiResponse({ status: 200, type: FleetDashboardDto })
  async get() {
    return JsonResponse.Ok(await this.dashboard.snapshot({ kind: 'global' }, new Date()));
  }
}
