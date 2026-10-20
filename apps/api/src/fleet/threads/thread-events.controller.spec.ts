import type { ExecutionContext } from '@nestjs/common';
import { PrismaService } from '@nathapp/nestjs-prisma';
import type { PrismaClient } from '../../generated/prisma/client';
import type { UserPrincipal } from '../../auth/principal/koda-principal.types';
import type { ILiveConfig } from '../../config/live.config';
import { LiveStreamRegistry } from '../../live/live-stream-registry';
import type { PermissionService } from '../../permissions/permission.service';
import type { ProjectAccessService } from '../../projects/project-access.service';
import { ThreadEventsGuard } from './thread-events.controller';

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
