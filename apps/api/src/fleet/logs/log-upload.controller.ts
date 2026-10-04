import { Controller, Headers, HttpCode, Param, Put, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiConsumes, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Principal } from '@nathapp/nestjs-auth';
import { JsonResponse } from '@nathapp/nestjs-common';
import { SkipThrottle } from '@nathapp/nestjs-throttler';
import { RunnerRoute } from '../../auth/guards/runner-route.decorator';
import type { RunnerPrincipal } from '../../auth/principal/koda-principal.types';
import { requestStream } from '../artifacts/bundle-upload.controller';
import { LogUploadService } from './log-upload.service';

@ApiTags('fleet-runner')
@ApiBearerAuth()
@RunnerRoute()
@SkipThrottle() // S2a §2.2: runner-key authenticated; its own byte rate applies (plan D312)
@Controller('fleet/runner/jobs')
export class LogUploadController {
  constructor(private readonly uploads: LogUploadService) {}

  @Put(':jobId/logs/:stream')
  @HttpCode(200)
  @ApiConsumes('application/octet-stream')
  @ApiOperation({ summary: 'Append bytes to a log stream of the held attempt at an exact offset (S2a §2.2)' })
  @ApiResponse({ status: 200, description: '{ outcome: appended|duplicate|offset|complete|stream_cap|rate_limited, size, retryAfterMs? }' })
  @ApiResponse({ status: 400, description: 'Invalid stream, leaseEpoch, offset, final, X-Content-SHA256, or an empty non-final body' })
  @ApiResponse({ status: 404, description: 'No such job' })
  @ApiResponse({ status: 409, description: 'Stale lease (ABANDON queued) or the job is in a terminal state' })
  @ApiResponse({ status: 413, description: 'Body larger than FLEET_LOG_CHUNK_MAX_BYTES' })
  @ApiResponse({ status: 422, description: 'X-Content-SHA256 mismatch' })
  @ApiResponse({ status: 507, description: 'The server could not store the bytes' })
  async append(
    @Principal() runner: RunnerPrincipal,
    @Param('jobId') jobId: string,
    @Param('stream') stream: string,
    @Query('leaseEpoch') leaseEpoch: string,
    @Query('offset') offset: string,
    @Query('final') final: string | undefined,
    @Headers('x-content-sha256') sha256: string,
    @Headers('content-length') contentLength: string,
    @Req() req: unknown,
  ) {
    return JsonResponse.Ok(await this.uploads.upload({
      runnerId: runner.id, jobId, streamRaw: stream, leaseEpochRaw: leaseEpoch, offsetRaw: offset, finalRaw: final,
      sha256Header: sha256, contentLength, body: requestStream(req),
    }));
  }
}
