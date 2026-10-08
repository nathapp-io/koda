import { Controller, Inject, MessageEvent, Param, Req, Sse } from '@nestjs/common';
import { ApiExcludeEndpoint, ApiTags } from '@nestjs/swagger';
import { Observable } from 'rxjs';
import { ForbiddenAppException, ThrottleAppException } from '@nathapp/nestjs-common';
import { Principal } from '@nathapp/nestjs-auth';
import { SkipThrottle } from '@nathapp/nestjs-throttler';
import { kodaTokenExtractor } from '../auth/auth.module';
import { JwtAuthProvider } from '../auth/jwt-auth.provider';
import { isUserPrincipal, KodaPrincipal } from '../auth/principal/koda-principal.types';
import { ILiveConfig, LIVE_CFG } from '../config/live.config';
import { ProjectAccessService } from '../projects/project-access.service';
import { decodeJwtPayload, tokenExpiryMs } from './jwt-payload';
import { createLiveStream } from './live-stream';
import { LiveStreamRegistry } from './live-stream-registry';
import { ProjectEventBus } from './project-event-bus';

/**
 * Track 1 Slice 5: browser live updates for one project over SSE.
 * Browser-only (agents refused), so it is excluded from openapi.json.
 */
@ApiTags('live')
@Controller('projects/:slug/events')
export class LiveController {
  constructor(
    private readonly access: ProjectAccessService,
    private readonly bus: ProjectEventBus,
    private readonly streams: LiveStreamRegistry,
    private readonly jwtAuth: JwtAuthProvider,
    @Inject(LIVE_CFG) private readonly config: ILiveConfig,
  ) {}

  @Sse()
  @SkipThrottle()
  @ApiExcludeEndpoint()
  async events(
    @Param('slug') slug: string,
    @Principal() principal: KodaPrincipal,
    @Req() req: unknown,
  ): Promise<Observable<MessageEvent>> {
    if (!principal || !isUserPrincipal(principal)) throw new ForbiddenAppException({}, 'live');
    const projectId = await this.access.findProjectIdBySlug(slug);
    await this.access.assertProjectMembership(projectId, principal);
    const jwtPayload = decodeJwtPayload(kodaTokenExtractor(req));
    if (!jwtPayload) throw new ForbiddenAppException({}, 'live');
    if (!this.streams.tryAcquire(principal.id, this.config.maxStreamsPerUser)) {
      throw new ThrottleAppException({}, 'live');
    }
    return createLiveStream({
      key: projectId,
      heartbeatMs: this.config.heartbeatMs,
      expiresAtMs: tokenExpiryMs(jwtPayload),
      now: Date.now,
      subscribe: (id, listener) => this.bus.subscribe(id, listener),
      stillAllowed: () => this.stillAllowed(projectId, jwtPayload),
      onClose: () => this.streams.release(principal.id),
    });
  }

  /** tokenVersion and disabled via the 60 s auth-state cache; membership live. */
  private async stillAllowed(projectId: string, jwtPayload: Record<string, unknown>): Promise<boolean> {
    const fresh = await this.jwtAuth.getPrincipal(jwtPayload);
    if (fresh.revoked) return false;
    try {
      await this.access.assertProjectMembership(projectId, fresh);
      return true;
    } catch {
      return false;
    }
  }
}
