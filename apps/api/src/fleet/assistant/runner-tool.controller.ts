import { Body, Controller, HttpCode, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Principal } from '@nathapp/nestjs-auth';
import { JsonResponse } from '@nathapp/nestjs-common';
import { SkipThrottle } from '@nathapp/nestjs-throttler';
import { RunnerRoute } from '../../auth/guards/runner-route.decorator';
import { RequiresGuard } from '../../permissions/requires.guard';
import { Requires } from '../../permissions/requires.decorator';
import type { RunnerPrincipal } from '../../auth/principal/koda-principal.types';
import { RunnerToolService } from './runner-tool.service';

/**
 * Fleet S5b US-005 (1b-R1): the runner's job-scoped koda tool route, the shape of every other runner job route
 * (`log-upload.controller.ts`, `bundle-upload.controller.ts`). The thread is the job's `threadId`; the runner proves
 * the lease with `?leaseEpoch=<n>`. The controller only maps parameters — the refusals live in `RunnerToolService`.
 */
@ApiTags('fleet-runner')
@ApiBearerAuth()
@RunnerRoute()
@UseGuards(RequiresGuard)
@SkipThrottle() // S5b: runner-key authenticated; calls are bounded by the session's own turn loop
@Controller('fleet/runner/jobs')
export class RunnerToolController {
  constructor(private readonly tools: RunnerToolService) {}

  @Post(':jobId/tools/:name')
  @HttpCode(200)
  @ApiOperation({ summary: 'Run one koda tool for the thread of the held job at its lease (S5b §1b)' })
  @ApiResponse({ status: 200, description: '{ content, isError } — a tool-level refusal is isError: true, not an HTTP error' })
  @ApiResponse({ status: 400, description: 'Invalid leaseEpoch or malformed body' })
  @ApiResponse({ status: 401, description: 'Runner authentication failed' })
  @ApiResponse({ status: 404, description: 'No such job, or an unknown koda tool' })
  @Requires('runner.tool.call')
  @ApiResponse({ status: 409, description: 'Threads disabled, stale lease, not a THREAD job, the job is not RUNNING, or the thread is closing' })
  async call(
    @Principal() runner: RunnerPrincipal,
    @Param('jobId') jobId: string,
    @Param('name') name: string,
    @Query('leaseEpoch') leaseEpoch: string | undefined,
    @Body() body: unknown,
  ) {
    return JsonResponse.Ok(await this.tools.call(runner.id, jobId, leaseEpoch, name, body));
  }
}
