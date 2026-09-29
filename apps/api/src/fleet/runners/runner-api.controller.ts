import { Body, Controller, Get, HttpCode, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Principal, Public } from '@nathapp/nestjs-auth';
import { JsonResponse } from '@nathapp/nestjs-common';
import { Throttle } from '@nathapp/nestjs-throttler';
import { RunnerRoute } from '../../auth/guards/runner-route.decorator';
import type { RunnerPrincipal } from '../../auth/principal/koda-principal.types';
import { EnrollmentService } from './enrollment.service';
import { EnrollDto } from './dto/enroll.dto';

/** Runner-facing routes (spec §3). Only runner keys work here (CombinedAuthGuard). */
@ApiTags('fleet-runner')
@ApiBearerAuth()
@RunnerRoute()
@Controller('fleet/runner')
export class RunnerApiController {
  constructor(private readonly enrollments: EnrollmentService) {}

  @Post('enroll')
  @HttpCode(201)
  @Public()
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @ApiOperation({ summary: 'Enroll a runner with a single-use token; returns its API key once' })
  @ApiResponse({ status: 201, description: '{ runnerId, apiKey }' })
  @ApiResponse({ status: 401, description: 'Token invalid, used or expired' })
  @ApiResponse({ status: 409, description: 'Runner name taken; the token stays usable' })
  @ApiResponse({ status: 426, description: 'Unsupported protocol version' })
  async enroll(@Body() dto: EnrollDto) {
    return JsonResponse.Ok(await this.enrollments.enroll(dto));
  }

  @Get('me')
  @ApiOperation({ summary: "The calling runner's identity" })
  @ApiResponse({ status: 200, description: '{ id, name, labels, enabled }' })
  async me(@Principal() runner: RunnerPrincipal) {
    return JsonResponse.Ok({ id: runner.id, name: runner.runnerName, labels: runner.labels, enabled: runner.enabled });
  }
}
