import { Body, Controller, Get, HttpCode, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Principal, Public } from '@nathapp/nestjs-auth';
import { JsonResponse } from '@nathapp/nestjs-common';
import { Throttle } from '@nathapp/nestjs-throttler';
import { RunnerRoute } from '../../auth/guards/runner-route.decorator';
import { RequiresGuard } from '../../permissions/requires.guard';
import { Requires } from '../../permissions/requires.decorator';
import type { RunnerPrincipal } from '../../auth/principal/koda-principal.types';
import { EnrollmentService } from './enrollment.service';
import { EnrollDto } from './dto/enroll.dto';
import { FLEET_ENROLL_LIMIT, FLEET_ENROLL_TTL_MS } from './enroll-throttle';

/** Runner-facing routes (spec §3). Only runner keys work here (CombinedAuthGuard). */
@ApiTags('fleet-runner')
@ApiBearerAuth()
@RunnerRoute()
@UseGuards(RequiresGuard)
@Controller('fleet/runner')
export class RunnerApiController {
  constructor(private readonly enrollments: EnrollmentService) {}

  @Post('enroll')
  @Requires('runner.enroll', { enforcedBy: 'service' })
  @HttpCode(201)
  @Public()
  @Throttle({ default: { limit: FLEET_ENROLL_LIMIT, ttl: FLEET_ENROLL_TTL_MS } })
  @ApiOperation({ summary: 'Enroll a runner with a single-use token; returns its API key once' })
  @ApiResponse({ status: 201, description: '{ runnerId, apiKey }' })
  @ApiResponse({ status: 401, description: 'Token invalid, used or expired' })
  @ApiResponse({ status: 409, description: 'Runner name taken; the token stays usable' })
  @ApiResponse({ status: 426, description: 'Unsupported protocol version' })
  async enroll(@Body() dto: EnrollDto) {
    return JsonResponse.Ok(await this.enrollments.enroll(dto));
  }

  @Get('me')
  @Requires('runner.self.read')
  @ApiOperation({ summary: "The calling runner's identity" })
  @ApiResponse({ status: 200, description: '{ id, name, labels, capacity, enabled }' })
  async me(@Principal() runner: RunnerPrincipal) {
    return JsonResponse.Ok({ id: runner.id, name: runner.runnerName, labels: runner.labels, capacity: runner.capacity, enabled: runner.enabled });
  }
}
