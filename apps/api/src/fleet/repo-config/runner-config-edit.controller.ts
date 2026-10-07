import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Principal } from '@nathapp/nestjs-auth';
import { JsonResponse } from '@nathapp/nestjs-common';
import { RunnerRoute } from '../../auth/guards/runner-route.decorator';
import type { RunnerPrincipal } from '../../auth/principal/koda-principal.types';
import { ConfigJobsService } from './config-jobs.service';
import { ConfigEditPayloadDto } from './dto/config-edit.dto';

@ApiTags('fleet-runner')
@ApiBearerAuth()
@RunnerRoute()
@Controller('fleet/runner/jobs')
export class RunnerConfigEditController {
  constructor(private readonly configJobs: ConfigJobsService) {}

  @Get(':jobId/config-edit')
  @ApiOperation({ summary: "A config job's edit set for the lease holder (fleet S3 §3); fetched before RUNNING" })
  @ApiResponse({ status: 200, type: ConfigEditPayloadDto })
  @ApiResponse({ status: 409, description: 'Stale lease (ABANDON queued), or the job is not ASSIGNED/RUNNING' })
  async get(@Principal() runner: RunnerPrincipal, @Param('jobId') jobId: string, @Query('leaseEpoch') leaseEpoch: string | undefined) {
    return JsonResponse.Ok(await this.configJobs.fetchForRunner(runner.id, jobId, leaseEpoch));
  }
}
