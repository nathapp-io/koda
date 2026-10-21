import { CanActivate, Controller, ExecutionContext, Inject, Injectable, MessageEvent, Param, Req, Sse, UseGuards } from '@nestjs/common';
import { ApiExcludeEndpoint, ApiTags } from '@nestjs/swagger';
import { ForbiddenAppException, ThrottleAppException } from '@nathapp/nestjs-common';
import { Principal } from '@nathapp/nestjs-auth';
import { SkipThrottle } from '@nathapp/nestjs-throttler';
import { Observable } from 'rxjs';
import { kodaTokenExtractor } from '../../auth/auth.module';
import { JwtAuthProvider } from '../../auth/jwt-auth.provider';
import { KodaPrincipal } from '../../auth/principal/koda-principal.types';
import { ILiveConfig, LIVE_CFG } from '../../config/live.config';
import { decodeJwtPayload, tokenExpiryMs } from '../../live/jwt-payload';
import { createLiveStream } from '../../live/live-stream';
import { LiveStreamRegistry } from '../../live/live-stream-registry';
import { ThreadEventBus, type ThreadLiveEvent } from '../../live/thread-event-bus';
import { WorkspaceThreadsService } from './workspace-threads.service';
import { Requires } from '../../permissions/requires.decorator';
import { RequiresGuard } from '../../permissions/requires.guard';

interface WorkspaceThreadEventsRequest {
  params: { id: string };
  user?: KodaPrincipal;
  workspaceThreadEvents?: { jwtPayload: Record<string, unknown> };
}

/**
 * Authorization and capacity checks run before Nest opens the SSE response (as `ThreadEventsGuard`). Unlike the
 * project stream there is no project membership and, since permissions P1 US-003, no principal-type refusal either:
 * the workspace scope's own read already answers 404 to anyone but the creator, global admins and agents included
 * (fleet S5b 1d-D2), and it answers before a stream slot is acquired. The JWT check below is unchanged.
 *
 * Permissions P1 (US-002): `thread.workspace.read` is a route key now. `RequiresGuard` runs first — a caller
 * holding neither the key nor `.own` is refused with 403 `permissions` before this fence, the JWT read and the
 * stream slot. A `.own` holder passes (`RequiresGuard` answers `not-owner`) and this fence still decides, so a
 * Member's own stream behaves as before.
 */
@Injectable()
export class WorkspaceThreadEventsGuard implements CanActivate {
  constructor(
    private readonly threads: WorkspaceThreadsService,
    private readonly streams: LiveStreamRegistry,
    @Inject(LIVE_CFG) private readonly config: ILiveConfig,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<WorkspaceThreadEventsRequest>();
    const principal = req.user;
    if (!principal) throw new ForbiddenAppException({}, 'live');

    await this.threads.requireOwnedThread(principal.id, req.params.id);

    const jwtPayload = decodeJwtPayload(kodaTokenExtractor(req));
    if (!jwtPayload) throw new ForbiddenAppException({}, 'live');
    if (!this.streams.tryAcquire(principal.id, this.config.maxStreamsPerUser)) {
      throw new ThrottleAppException({}, 'live');
    }
    req.workspaceThreadEvents = { jwtPayload };
    return true;
  }
}

@ApiTags('live')
@Controller('threads/:id/events')
// Order matters: the key is asked before the ownership fence, the JWT read and the stream slot.
@UseGuards(RequiresGuard, WorkspaceThreadEventsGuard)
export class WorkspaceThreadEventsController {
  constructor(
    private readonly bus: ThreadEventBus,
    private readonly streams: LiveStreamRegistry,
    private readonly jwtAuth: JwtAuthProvider,
    @Inject(LIVE_CFG) private readonly config: ILiveConfig,
  ) {}

  @Sse()
  @Requires('thread.workspace.read')
  @SkipThrottle()
  @ApiExcludeEndpoint()
  async events(
    @Param('id') threadId: string,
    @Principal() principal: KodaPrincipal,
    @Req() req: WorkspaceThreadEventsRequest,
  ): Promise<Observable<MessageEvent>> {
    const authorized = req.workspaceThreadEvents;
    if (!authorized) {
      this.streams.release(principal.id);
      throw new ForbiddenAppException({}, 'live');
    }
    const { jwtPayload } = authorized;
    return createLiveStream<ThreadLiveEvent>({
      key: threadId,
      heartbeatMs: this.config.heartbeatMs,
      expiresAtMs: tokenExpiryMs(jwtPayload),
      now: Date.now,
      subscribe: (id, listener) => this.bus.subscribe(id, listener),
      stillAllowed: async () => {
        const fresh = await this.jwtAuth.getPrincipal(jwtPayload);
        return !fresh.revoked;
      },
      onClose: () => this.streams.release(principal.id),
    });
  }
}
