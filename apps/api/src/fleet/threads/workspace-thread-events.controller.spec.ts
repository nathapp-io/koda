import type { ExecutionContext } from '@nestjs/common';
import { CanActivate } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { NotFoundAppException } from '@nathapp/nestjs-common';
import request from 'supertest';
import type { AgentPrincipal, KodaPrincipal, UserPrincipal } from '../../auth/principal/koda-principal.types';
import type { ILiveConfig } from '../../config/live.config';
import { LIVE_CFG } from '../../config/live.config';
import { JwtAuthProvider } from '../../auth/jwt-auth.provider';
import { LiveStreamRegistry } from '../../live/live-stream-registry';
import { ThreadEventBus } from '../../live/thread-event-bus';
import { PermissionService } from '../../permissions/permission.service';
import { RequiresGuard } from '../../permissions/requires.guard';
import { WorkspaceThreadEventsController, WorkspaceThreadEventsGuard } from './workspace-thread-events.controller';
import { WorkspaceThreadsService } from './workspace-threads.service';

/** A JWT the auth guard has already verified: only the payload the stream reads matters here. */
const token = (payload: Record<string, unknown>): string =>
  ['header', Buffer.from(JSON.stringify(payload)).toString('base64url'), 'signature'].join('.');

/**
 * US-004: the events guard is the only authorization on the stream route — creator-only, 404 for anyone
 * else (1d-D2), and the refusal happens before a stream slot is taken.
 */
describe('workspace thread events guard', () => {
  const dev: UserPrincipal = { actorType: 'user', id: 'u', role: 'MEMBER', email: 'dev@koda.test' };
  const agent: AgentPrincipal = { actorType: 'agent', id: 'a', slug: 'a', status: 'ACTIVE', agentRoles: [], capabilities: [] };
  let threads: { requireOwnedThread: ReturnType<typeof vi.fn> };
  let streams: LiveStreamRegistry;
  let guard: WorkspaceThreadEventsGuard;

  interface GuardRequest { params: { id: string }; user?: KodaPrincipal; headers: Record<string, string>; workspaceThreadEvents?: unknown }
  const request = (user: KodaPrincipal | undefined, bearer?: string): GuardRequest => ({
    params: { id: 't1' }, user, headers: bearer ? { authorization: `Bearer ${bearer}` } : {},
  });
  const context = (req: GuardRequest): ExecutionContext =>
    ({ switchToHttp: () => ({ getRequest: () => req }) }) as unknown as ExecutionContext;

  beforeEach(() => {
    threads = { requireOwnedThread: vi.fn(async () => ({ id: 't1' })) };
    streams = new LiveStreamRegistry();
    guard = new WorkspaceThreadEventsGuard(
      threads as unknown as WorkspaceThreadsService,
      streams,
      { heartbeatMs: 25_000, maxStreamsPerUser: 2 } as ILiveConfig,
    );
  });

  // US-003: the principal-type refusal is gone. A non-user principal is judged by the same
  // owned-thread fence (404 for anything that is not its own WORKSPACE thread) and the JWT check.
  it('accepts a non-user principal the workspace fence allows, on the same terms as a user', async () => {
    const req = request(agent, token({ sub: 'a', exp: 1_800_000_000 }));

    await expect(guard.canActivate(context(req))).resolves.toBe(true);
    expect(threads.requireOwnedThread).toHaveBeenCalledWith('a', 't1');
    expect(req.workspaceThreadEvents).toEqual({ jwtPayload: { sub: 'a', exp: 1_800_000_000 } });
    expect(streams.activeFor('a')).toBe(1);
  });

  it('answers 404 threads.notFound for a thread the caller does not own, before taking a slot', async () => {
    threads.requireOwnedThread.mockRejectedValue(new NotFoundAppException({}, 'threads.notFound'));
    await expect(guard.canActivate(context(request(dev, token({ sub: 'u' }))))).rejects.toMatchObject({ prefix: 'threads.notFound', httpStatus: 404 });
    expect(threads.requireOwnedThread).toHaveBeenCalledWith('u', 't1');
    expect(streams.activeFor('u')).toBe(0);
  });

  it('opens the creator stream and hands the stream the verified token payload', async () => {
    const req = request(dev, token({ sub: 'u', exp: 1_800_000_000 }));
    await expect(guard.canActivate(context(req))).resolves.toBe(true);
    expect(req.workspaceThreadEvents).toEqual({ jwtPayload: { sub: 'u', exp: 1_800_000_000 } });
    expect(streams.activeFor('u')).toBe(1);
  });

  it('refuses with 429 live when the caller already holds the maximum streams', async () => {
    streams.tryAcquire('u', 2);
    streams.tryAcquire('u', 2);
    await expect(guard.canActivate(context(request(dev, token({ sub: 'u' }))))).rejects.toMatchObject({ prefix: 'live', httpStatus: 429 });
    expect(streams.activeFor('u')).toBe(2);
  });

  it('refuses a user request that carries no JWT payload', async () => {
    await expect(guard.canActivate(context(request(dev)))).rejects.toMatchObject({ prefix: 'live', httpStatus: 403 });
    expect(streams.activeFor('u')).toBe(0);
  });
});

/**
 * Permissions P1 US-002 AC-14: `thread.workspace.read` is a guard key on the stream route, checked
 * *before* the ownership fence and before a stream slot is taken. Boots the real controller with
 * `RequiresGuard` first in the class `@UseGuards(...)`, over a real Fastify HTTP server, with every
 * collaborator stubbed (no database, no network).
 */
describe('GET /threads/:id/events permission guard (US-002 AC-14)', () => {
  const dev: UserPrincipal = { actorType: 'user', id: 'u', role: 'MEMBER', email: 'dev@koda.test' } as UserPrincipal;

  let module: TestingModule;
  let app: NestFastifyApplication;
  let threads: { requireOwnedThread: ReturnType<typeof vi.fn> };
  let streams: LiveStreamRegistry;
  /** The double's answer for `thread.workspace.read`; each case sets it. */
  let decision: { allowed: boolean; reason: string };
  const can = vi.fn(async () => decision);
  let currentPrincipal: KodaPrincipal;

  beforeAll(async () => {
    threads = { requireOwnedThread: vi.fn() };
    streams = new LiveStreamRegistry();

    module = await Test.createTestingModule({
      controllers: [WorkspaceThreadEventsController],
      providers: [
        WorkspaceThreadEventsGuard,
        // The class `@UseGuards(RequiresGuard, WorkspaceThreadEventsGuard)` order is under test.
        RequiresGuard,
        { provide: WorkspaceThreadsService, useValue: threads },
        { provide: LiveStreamRegistry, useValue: streams },
        { provide: ThreadEventBus, useValue: { subscribe: vi.fn() } },
        { provide: JwtAuthProvider, useValue: { getPrincipal: vi.fn(async () => ({ revoked: false })) } },
        { provide: PermissionService, useValue: { can } },
        { provide: LIVE_CFG, useValue: { heartbeatMs: 25_000, maxStreamsPerUser: 2 } as ILiveConfig },
      ],
    }).compile();

    app = module.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    // Stands in for the global CombinedAuthGuard, which puts the principal on the request.
    const principalInjector: CanActivate = {
      canActivate: (ctx: ExecutionContext) => {
        ctx.switchToHttp().getRequest<{ user?: KodaPrincipal }>().user = currentPrincipal;
        return true;
      },
    };
    app.useGlobalGuards(principalInjector);

    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    currentPrincipal = dev;
    threads.requireOwnedThread.mockResolvedValue({ id: 't1' });
  });

  it('AC-14: answers 403 permissions before the ownership fence or a stream slot', async () => {
    decision = { allowed: false, reason: 'not-granted' };

    const res = await request(app.getHttpServer()).get('/threads/t1/events');

    expect(res.status).toBe(403);
    // No global exception filter in this bare app: the ForbiddenAppException is serialized as-is.
    expect(res.body).toEqual(expect.objectContaining({ code: 40003, prefix: 'permissions' }));
    expect(can).toHaveBeenCalledWith(dev, 'thread.workspace.read', {});
    // The 404 ownership fence and the stream slot are never reached.
    expect(threads.requireOwnedThread).not.toHaveBeenCalled();
    expect(streams.activeFor('u')).toBe(0);
  });

  it('AC-14 boundary: a .own-only holder passes the key and the ownership fence still decides', async () => {
    // `RequiresGuard` passes `not-owner`: holding `thread.workspace.read.own` grants the route and the
    // guard's fence answers 404 for a thread that is not the caller's.
    decision = { allowed: false, reason: 'not-owner' };
    threads.requireOwnedThread.mockRejectedValue(new NotFoundAppException({}, 'threads.notFound'));

    const res = await request(app.getHttpServer()).get('/threads/t1/events');

    expect(res.status).toBe(404);
    expect(res.body).toEqual(expect.objectContaining({ code: 404, prefix: 'threads.notFound' }));
    expect(threads.requireOwnedThread).toHaveBeenCalledWith('u', 't1');
    expect(streams.activeFor('u')).toBe(0);
  });
});
