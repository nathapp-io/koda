import type { ExecutionContext, MessageEvent } from '@nestjs/common';
import type { Observable } from 'rxjs';
import { PrismaService } from '@nathapp/nestjs-prisma';
import type { PrismaClient } from '../../generated/prisma/client';
import type { UserPrincipal } from '../../auth/principal/koda-principal.types';
import type { JwtAuthProvider } from '../../auth/jwt-auth.provider';
import type { ILiveConfig } from '../../config/live.config';
import { LiveStreamRegistry } from '../../live/live-stream-registry';
import type { ThreadEventBus } from '../../live/thread-event-bus';
import type { PermissionService } from '../../permissions/permission.service';
import type { ProjectAccessService } from '../../projects/project-access.service';
import { ThreadEventsController, ThreadEventsGuard } from './thread-events.controller';

/** A JWT the auth guard has already verified: only the payload the stream reads matters here. */
const token = (payload: Record<string, unknown>): string =>
  ['header', Buffer.from(JSON.stringify(payload)).toString('base64url'), 'signature'].join('.');

/**
 * Permissions P1 US-002 AC-14: the project thread stream is a `thread.read` route. A member who does
 * not hold the key is refused with the permissions code after the membership check and before the
 * JWT is read — so a caller with no token never learns that a token was the next gate.
 */
describe('ThreadEventsGuard (US-002)', () => {
  const dev: UserPrincipal = { actorType: 'user', id: 'u', role: 'MEMBER', email: 'dev@koda.test' };
  let access: { findProjectIdBySlug: ReturnType<typeof vi.fn>; assertProjectMembership: ReturnType<typeof vi.fn> };
  let chatThread: { findFirst: ReturnType<typeof vi.fn> };
  let can: ReturnType<typeof vi.fn>;
  let streams: LiveStreamRegistry;
  let guard: ThreadEventsGuard;

  interface GuardRequest { params: { slug: string; id: string }; user?: UserPrincipal; headers: Record<string, string>; threadEvents?: unknown }
  const request = (bearer?: string): GuardRequest => ({
    params: { slug: 'p1', id: 't1' }, user: dev, headers: bearer ? { authorization: `Bearer ${bearer}` } : {},
  });
  const context = (req: GuardRequest): ExecutionContext =>
    ({ switchToHttp: () => ({ getRequest: () => req }) }) as unknown as ExecutionContext;

  beforeEach(() => {
    access = {
      findProjectIdBySlug: vi.fn(async () => 'proj-1'),
      assertProjectMembership: vi.fn(async () => ({ role: 'VIEWER' })),
    };
    chatThread = { findFirst: vi.fn(async () => ({ projectId: 'proj-1' })) };
    can = vi.fn(async () => ({ allowed: true, reason: 'granted' }));
    streams = new LiveStreamRegistry();
    guard = new ThreadEventsGuard(
      access as unknown as ProjectAccessService,
      { client: { chatThread } } as unknown as PrismaService<PrismaClient>,
      streams,
      { heartbeatMs: 25_000, maxStreamsPerUser: 2 } as ILiveConfig,
      { can } as unknown as PermissionService,
    );
  });

  it('AC-14: refuses a member without thread.read with 403 permissions, before reading the JWT', async () => {
    can.mockResolvedValue({ allowed: false, reason: 'no-grant' });

    // No bearer token at all: if the guard reached the JWT check it would answer `live`, not `permissions`.
    await expect(guard.canActivate(context(request()))).rejects.toMatchObject({ prefix: 'permissions', httpStatus: 403 });

    expect(access.assertProjectMembership).toHaveBeenCalledWith('proj-1', dev);
    expect(can).toHaveBeenCalledWith(dev, 'thread.read', { projectId: 'proj-1' });
    // The key refusal runs before the thread lookup and before a stream slot is taken.
    expect(chatThread.findFirst).not.toHaveBeenCalled();
    expect(streams.activeFor('u')).toBe(0);
  });

  it('AC-14: asks the key for the project the slug resolved, not for the thread', async () => {
    can.mockResolvedValue({ allowed: false, reason: 'no-grant' });

    await expect(guard.canActivate(context(request()))).rejects.toMatchObject({ prefix: 'permissions' });

    expect(access.findProjectIdBySlug).toHaveBeenCalledWith('p1');
    expect(can).toHaveBeenCalledTimes(1);
  });

  it('opens the stream for a member who holds thread.read and carries a JWT', async () => {
    const req = request(token({ sub: 'u', exp: 1_800_000_000 }));

    await expect(guard.canActivate(context(req))).resolves.toBe(true);

    expect(chatThread.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ id: 't1', projectId: 'proj-1' }) }));
    expect(req.threadEvents).toEqual({ projectId: 'proj-1', jwtPayload: { sub: 'u', exp: 1_800_000_000 } });
    expect(streams.activeFor('u')).toBe(1);
  });

  it('still refuses a key holder without a JWT with 403 live', async () => {
    await expect(guard.canActivate(context(request()))).rejects.toMatchObject({ prefix: 'live', httpStatus: 403 });
    expect(streams.activeFor('u')).toBe(0);
  });
});

/**
 * US-008: the thread stream re-check used to confirm project membership only, so a member whose
 * `thread.read` was revoked kept receiving events. `stillAllowed` now also asks the key the guard
 * checked when the stream opened, and a denial or a rejected decision closes the stream.
 */
describe('ThreadEventsController.events re-checks thread.read (US-008)', () => {
  const dev: UserPrincipal = { actorType: 'user', id: 'u', role: 'MEMBER', email: 'dev@koda.test' };
  const fresh = { ...dev, revoked: false };
  const jwtPayload = { sub: 'u', exp: 1_800_000_000 };
  let access: { assertProjectMembership: ReturnType<typeof vi.fn> };
  let can: ReturnType<typeof vi.fn>;
  let getPrincipal: ReturnType<typeof vi.fn>;
  let streams: LiveStreamRegistry;
  let controller: ThreadEventsController;

  const request = (): { params: { slug: string; id: string }; user: UserPrincipal; threadEvents: { projectId: string; jwtPayload: Record<string, unknown> } } => ({
    params: { slug: 'p1', id: 't1' }, user: dev, threadEvents: { projectId: 'proj-1', jwtPayload },
  });

  /** Subscribe to the stream the controller built and count what a client would see. */
  const openStream = async (): Promise<{ done: () => boolean; pings: () => number }> => {
    const stream = await controller.events('t1', dev, request());
    let completed = false;
    let pings = 0;
    (stream as Observable<MessageEvent>).subscribe({
      next: (event) => { if (event.type === 'ping') pings += 1; },
      complete: () => { completed = true; },
    });
    return { done: () => completed, pings: () => pings };
  };

  beforeEach(() => {
    vi.useFakeTimers();
    access = { assertProjectMembership: vi.fn(async () => ({ role: 'VIEWER' })) };
    can = vi.fn(async () => ({ allowed: true, reason: 'granted' }));
    getPrincipal = vi.fn(async () => fresh);
    streams = new LiveStreamRegistry();
    streams.tryAcquire('u', 2);
    controller = new ThreadEventsController(
      access as unknown as ProjectAccessService,
      { subscribe: () => () => undefined, publish: () => undefined } as unknown as ThreadEventBus,
      streams,
      { getPrincipal } as unknown as JwtAuthProvider,
      { heartbeatMs: 10, maxStreamsPerUser: 2 } as ILiveConfig,
      { can } as unknown as PermissionService,
    );
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('AC-1: completes the stream when a member no longer holds thread.read', async () => {
    can.mockResolvedValue({ allowed: false, reason: 'no-grant' });
    const stream = await openStream();

    await vi.advanceTimersByTimeAsync(20);

    expect(stream.done()).toBe(true);
    expect(access.assertProjectMembership).toHaveBeenCalledWith('proj-1', fresh);
    expect(can).toHaveBeenCalledWith(fresh, 'thread.read', { projectId: 'proj-1' });
  });

  it('AC-2: keeps the stream open for a member who still holds thread.read', async () => {
    const stream = await openStream();

    await vi.advanceTimersByTimeAsync(20);

    expect(stream.done()).toBe(false);
    expect(stream.pings()).toBeGreaterThan(0);
    expect(can).toHaveBeenCalledWith(fresh, 'thread.read', { projectId: 'proj-1' });
  });

  it('AC-3: completes the stream when the thread.read check rejects, rather than rejecting', async () => {
    can.mockRejectedValue(new Error('permission store down'));
    const stream = await openStream();

    await vi.advanceTimersByTimeAsync(20);

    expect(stream.done()).toBe(true);
    expect(can).toHaveBeenCalledWith(fresh, 'thread.read', { projectId: 'proj-1' });
  });
});
