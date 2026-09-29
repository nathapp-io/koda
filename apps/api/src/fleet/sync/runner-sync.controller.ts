import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Principal } from '@nathapp/nestjs-auth';
import { JsonResponse } from '@nathapp/nestjs-common';
import { SkipThrottle } from '@nathapp/nestjs-throttler';
import { RunnerRoute } from '../../auth/guards/runner-route.decorator';
import type { RunnerPrincipal } from '../../auth/principal/koda-principal.types';
import { SyncService } from './sync.service';

@ApiTags('fleet-runner')
@ApiBearerAuth()
@RunnerRoute()
@Controller('fleet/runner')
export class RunnerSyncController {
  constructor(private readonly syncService: SyncService) {}

  @Post('sync')
  @HttpCode(200)
  @SkipThrottle() // plan D20: runner-key authenticated; a 429 would delay acks and cancels
  @ApiOperation({ summary: 'Runner sync: events, command acks, token requests; long-polls when idle' })
  @ApiBody({ schema: { type: 'object', description: 'SyncRequest (packages/fleet-protocol)' } })
  @ApiResponse({ status: 200, description: 'SyncResponse (packages/fleet-protocol)' })
  @ApiResponse({ status: 400, description: 'Malformed sync request or capabilities' })
  @ApiResponse({ status: 426, description: 'Unsupported protocol version' })
  async sync(@Principal() runner: RunnerPrincipal, @Body() body: unknown) {
    return JsonResponse.Ok(await this.syncService.sync(runner.id, body));
  }
}
