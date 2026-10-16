import type { ExecutionContext } from '@nestjs/common';
import { NotFoundAppException } from '@nathapp/nestjs-common';
import type { AgentPrincipal, KodaPrincipal, UserPrincipal } from '../../auth/principal/koda-principal.types';
import type { ILiveConfig } from '../../config/live.config';
import { LiveStreamRegistry } from '../../live/live-stream-registry';
import { WorkspaceThreadEventsGuard } from './workspace-thread-events.controller';
import type { WorkspaceThreadsService } from './workspace-threads.service';

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

  it('refuses a non-user principal with 403 threads.principal', async () => {
    await expect(guard.canActivate(context(request(agent, token({ sub: 'a' }))))).rejects.toMatchObject({ prefix: 'threads.principal', httpStatus: 403 });
    expect(streams.activeFor('a')).toBe(0);
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
