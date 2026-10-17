import { CanActivate, Controller, ExecutionContext, Inject, Injectable, MessageEvent, Param, Req, Sse, UseGuards } from '@nestjs/common';
import { ApiExcludeEndpoint, ApiTags } from '@nestjs/swagger';
import { ForbiddenAppException, NotFoundAppException, ThrottleAppException } from '@nathapp/nestjs-common';
import { Principal } from '@nathapp/nestjs-auth';
import { SkipThrottle } from '@nathapp/nestjs-throttler';
import { Observable } from 'rxjs';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { PrismaClient } from '../../generated/prisma/client';
import { kodaTokenExtractor } from '../../auth/auth.module';
import { JwtAuthProvider } from '../../auth/jwt-auth.provider';
import { isUserPrincipal, KodaPrincipal } from '../../auth/principal/koda-principal.types';
import { ILiveConfig, LIVE_CFG } from '../../config/live.config';
import { ProjectAccessService } from '../../projects/project-access.service';
import { decodeJwtPayload, tokenExpiryMs } from '../../live/jwt-payload';
import { createLiveStream } from '../../live/live-stream';
import { LiveStreamRegistry } from '../../live/live-stream-registry';
import { ThreadEventBus, type ThreadLiveEvent } from '../../live/thread-event-bus';

interface ThreadEventsRequest {
  params: { slug: string; id: string };
  user?: KodaPrincipal;
  threadEvents?: { projectId: string; jwtPayload: Record<string, unknown> };
}

/** Authorization and capacity checks run before Nest opens the SSE response. */
@Injectable()
export class ThreadEventsGuard implements CanActivate {
  constructor(
    private readonly access: ProjectAccessService,
    private readonly prisma: PrismaService<PrismaClient>,
    private readonly streams: LiveStreamRegistry,
    @Inject(LIVE_CFG) private readonly config: ILiveConfig,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<ThreadEventsRequest>();
    const principal = req.user;
    if (!principal || !isUserPrincipal(principal)) throw new ForbiddenAppException({}, 'threads.principal');

    const projectId = await this.access.findProjectIdBySlug(req.params.slug);
    await this.access.assertProjectMembership(projectId, principal);
    const thread = await this.prisma.client.chatThread.findFirst({
      where: { id: req.params.id, projectId, kind: { not: 'WORKSPACE' } }, select: { projectId: true },
    });
    if (!thread || thread.projectId !== projectId) throw new NotFoundAppException({}, 'threads.notFound');

    const jwtPayload = decodeJwtPayload(kodaTokenExtractor(req));
    if (!jwtPayload) throw new ForbiddenAppException({}, 'live');
    if (!this.streams.tryAcquire(principal.id, this.config.maxStreamsPerUser)) {
      throw new ThrottleAppException({}, 'live');
    }
    req.threadEvents = { projectId, jwtPayload };
    return true;
  }
}

@ApiTags('live')
@Controller('projects/:slug/threads/:id/events')
@UseGuards(ThreadEventsGuard)
export class ThreadEventsController {
  constructor(
    private readonly access: ProjectAccessService,
    private readonly bus: ThreadEventBus,
    private readonly streams: LiveStreamRegistry,
    private readonly jwtAuth: JwtAuthProvider,
    @Inject(LIVE_CFG) private readonly config: ILiveConfig,
  ) {}

  @Sse()
  @SkipThrottle()
  @ApiExcludeEndpoint()
  async events(
    @Param('id') threadId: string,
    @Principal() principal: KodaPrincipal,
    @Req() req: ThreadEventsRequest,
  ): Promise<Observable<MessageEvent>> {
    const authorized = req.threadEvents;
    if (!authorized) {
      this.streams.release(principal.id);
      throw new ForbiddenAppException({}, 'live');
    }
    const { projectId, jwtPayload } = authorized;
    return createLiveStream<ThreadLiveEvent>({
      key: threadId,
      heartbeatMs: this.config.heartbeatMs,
      expiresAtMs: tokenExpiryMs(jwtPayload),
      now: Date.now,
      subscribe: (id, listener) => this.bus.subscribe(id, listener),
      stillAllowed: async () => {
        const fresh = await this.jwtAuth.getPrincipal(jwtPayload);
        if (fresh.revoked) return false;
        try {
          await this.access.assertProjectMembership(projectId, fresh);
          return true;
        } catch {
          return false;
        }
      },
      onClose: () => this.streams.release(principal.id),
    });
  }
}
