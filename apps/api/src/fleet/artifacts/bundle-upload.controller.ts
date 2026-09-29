import { Controller, Headers, HttpCode, Param, Put, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiConsumes, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Principal } from '@nathapp/nestjs-auth';
import { JsonResponse } from '@nathapp/nestjs-common';
import { Readable } from 'stream';
import { RunnerRoute } from '../../auth/guards/runner-route.decorator';
import type { RunnerPrincipal } from '../../auth/principal/koda-principal.types';
import { BundleService } from './bundle.service';

/**
 * Plan D12: Fastify (production) hands the raw stream in `req.body` via the application/gzip
 * parser; Express (the HTTP test harness) leaves the body unread, so the request is the stream.
 */
export function requestStream(req: unknown): Readable {
  const body = (req as { body?: unknown }).body;
  return body instanceof Readable ? body : (req as Readable);
}

@ApiTags('fleet-runner')
@ApiBearerAuth()
@RunnerRoute()
@Controller('fleet/runner/jobs')
export class BundleUploadController {
  constructor(private readonly bundles: BundleService) {}

  @Put(':jobId/bundle')
  @HttpCode(201)
  @ApiConsumes('application/gzip')
  @ApiOperation({ summary: 'Upload the run bundle (tar.gz) for the held lease; replaces this epoch\'s previous bundle' })
  @ApiResponse({ status: 201, description: '{ jobId, leaseEpoch, sizeBytes, sha256 }' })
  @ApiResponse({ status: 409, description: 'Stale lease, or job not RUNNING/UPLOADING' })
  @ApiResponse({ status: 413, description: 'Larger than FLEET_BUNDLE_MAX_BYTES' })
  @ApiResponse({ status: 415, description: 'Not application/gzip' })
  @ApiResponse({ status: 422, description: 'X-Content-SHA256 mismatch' })
  async upload(
    @Principal() runner: RunnerPrincipal,
    @Param('jobId') jobId: string,
    @Query('leaseEpoch') leaseEpoch: string,
    @Headers('x-content-sha256') sha256: string,
    @Headers('content-type') contentType: string,
    @Headers('content-length') contentLength: string,
    @Req() req: unknown,
  ) {
    return JsonResponse.Ok(await this.bundles.upload({
      runnerId: runner.id, jobId, leaseEpochRaw: leaseEpoch, sha256Header: sha256, contentType, contentLength, body: requestStream(req),
    }));
  }
}
