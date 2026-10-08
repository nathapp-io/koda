import { Controller, Inject, MessageEvent, Req, Sse } from '@nestjs/common';
import { ApiExcludeEndpoint, ApiTags } from '@nestjs/swagger';
import { Observable } from 'rxjs';
import { ForbiddenAppException, ThrottleAppException } from '@nathapp/nestjs-common';
import { Principal } from '@nathapp/nestjs-auth';
import { SkipThrottle } from '@nathapp/nestjs-throttler';
import { kodaTokenExtractor } from '../auth/auth.module';
import { JwtAuthProvider } from '../auth/jwt-auth.provider';
import { isUserPrincipal, KodaPrincipal } from '../auth/principal/koda-principal.types';
import { ILiveConfig, LIVE_CFG } from '../config/live.config';
import { decodeJwtPayload, tokenExpiryMs } from './jwt-payload';
import { createLiveStream } from './live-stream';
import { LiveStreamRegistry } from './live-stream-registry';
import { UserEventBus, UserLiveEvent } from './user-event-bus';

/**
 * Fleet S4a §4: the caller's own notification signal over SSE. Users only (agents and runners
 * refused); excluded from openapi. Shares the per-user stream cap with project streams (D509).
 */
@ApiTags('live')
@Controller('me/events')
export class MeLiveController {
  constructor(
    private readonly bus: UserEventBus,
    private readonly streams: LiveStreamRegistry,
    private readonly jwtAuth: JwtAuthProvider,
    @Inject(LIVE_CFG) private readonly config: ILiveConfig,
  ) {}

  @Sse()
  @SkipThrottle()
  @ApiExcludeEndpoint()
  async events(@Principal() principal: KodaPrincipal, @Req() req: unknown): Promise<Observable<MessageEvent>> {
    if (!principal || !isUserPrincipal(principal)) throw new ForbiddenAppException({}, 'live');
    const jwtPayload = decodeJwtPayload(kodaTokenExtractor(req));
    if (!jwtPayload) throw new ForbiddenAppException({}, 'live');
    if (!this.streams.tryAcquire(principal.id, this.config.maxStreamsPerUser)) {
      throw new ThrottleAppException({}, 'live');
    }
    return createLiveStream<UserLiveEvent>({
      key: principal.id,
      heartbeatMs: this.config.heartbeatMs,
      expiresAtMs: tokenExpiryMs(jwtPayload),
      now: Date.now,
      subscribe: (userId, listener) => this.bus.subscribe(userId, listener),
      stillAllowed: async () => !(await this.jwtAuth.getPrincipal(jwtPayload)).revoked,
      onClose: () => this.streams.release(principal.id),
    });
  }
}
