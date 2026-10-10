import type { Mock } from 'vitest';
import { ForbiddenAppException, ThrottleAppException } from '@nathapp/nestjs-common';
import { firstValueFrom, take, toArray } from 'rxjs';
import type { ProjectAccessService } from '../projects/project-access.service';
import type { JwtAuthProvider } from '../auth/jwt-auth.provider';
import type { KodaPrincipal } from '../auth/principal/koda-principal.types';
import { LiveController } from './live.controller';
import { LiveStreamRegistry } from './live-stream-registry';
import { ProjectEventBus } from './project-event-bus';

const b64url = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url');
const jwtFor = (payload: Record<string, unknown>): string => `${b64url({ alg: 'HS256' })}.${b64url(payload)}.sig`;

const user: KodaPrincipal = {
  actorType: 'user', id: 'u1', sub: 'u1', role: 'MEMBER', email: 'u1@koda.test',
  name: 'u1', blacklisted: false, revoked: false, authorities: [],
};
const agent: KodaPrincipal = {
  actorType: 'agent', id: 'a1', sub: 'a1', slug: 'bot', status: 'ACTIVE', agentRoles: [], capabilities: [],
  name: 'bot', blacklisted: false, revoked: false, authorities: [],
};

function setup(overrides: { membership?: Mock; revoked?: boolean } = {}) {
  const access = {
    findProjectIdBySlug: vi.fn().mockResolvedValue('p1'),
    assertProjectMembership: overrides.membership ?? vi.fn().mockResolvedValue(undefined),
  } as unknown as ProjectAccessService;
  const jwtAuth = {
    getPrincipal: vi.fn().mockResolvedValue({ ...user, revoked: overrides.revoked ?? false }),
  } as unknown as JwtAuthProvider;
  const bus = new ProjectEventBus();
  const streams = new LiveStreamRegistry();
  const controller = new LiveController(access, bus, streams, jwtAuth, { heartbeatMs: 25000, maxStreamsPerUser: 5 });
  const req = { headers: { authorization: `Bearer ${jwtFor({ sub: 'u1', tokenVersion: 0, exp: Math.floor(Date.now() / 1000) + 900 })}` } };
  return { controller, access, jwtAuth, bus, streams, req };
}

describe('LiveController', () => {
  it('refuses agent principals with 403', async () => {
    const { controller, req } = setup();
    await expect(controller.events('proj', agent, req)).rejects.toBeInstanceOf(ForbiddenAppException);
  });

  it('propagates the membership refusal and takes no stream slot', async () => {
    const denied = vi.fn().mockRejectedValue(new ForbiddenAppException({}, 'projects'));
    const { controller, streams, req } = setup({ membership: denied });
    await expect(controller.events('proj', user, req)).rejects.toBeInstanceOf(ForbiddenAppException);
    expect(streams.activeFor('u1')).toBe(0);
  });

  it('refuses a 6th concurrent stream with 429', async () => {
    const { controller, streams, req } = setup();
    for (let i = 0; i < 5; i += 1) streams.tryAcquire('u1', 5);
    await expect(controller.events('proj', user, req)).rejects.toBeInstanceOf(ThrottleAppException);
  });

  it('streams ready then the project events, and releases the slot on close', async () => {
    const { controller, bus, streams, req } = setup();
    const stream = await controller.events('proj', user, req);
    expect(streams.activeFor('u1')).toBe(1);

    const firstTwo = firstValueFrom(stream.pipe(take(2), toArray()));
    bus.publish({ id: 'evt-1', type: 'ticket', action: 'created', projectId: 'p1', ticketId: 't1', actorId: 'u2', at: 'x' });
    const messages = await firstTwo;

    expect(messages.map((m) => m.type)).toEqual(['ready', 'ticket']);
    expect(streams.activeFor('u1')).toBe(0);
  });

  it('re-validates with the fresh principal: a revoked user loses access', async () => {
    vi.useFakeTimers();
    const { controller, jwtAuth, req } = setup({ revoked: true });
    const stream = await controller.events('proj', user, req);
    let completed = false;
    const sub = stream.subscribe({ complete: () => { completed = true; } });

    await vi.advanceTimersByTimeAsync(25000);

    expect(jwtAuth.getPrincipal).toHaveBeenCalledWith(expect.objectContaining({ sub: 'u1', tokenVersion: 0 }));
    expect(completed).toBe(true);
    sub.unsubscribe();
    vi.useRealTimers();
  });

  it('re-validates membership live: removal loses access', async () => {
    vi.useFakeTimers();
    const membership = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValue(new ForbiddenAppException({}, 'projects'));
    const { controller, req } = setup({ membership });
    const stream = await controller.events('proj', user, req);
    let completed = false;
    const sub = stream.subscribe({ complete: () => { completed = true; } });

    await vi.advanceTimersByTimeAsync(25000);

    expect(completed).toBe(true);
    sub.unsubscribe();
    vi.useRealTimers();
  });

  it('skips the global throttler', () => {
    expect(Reflect.getMetadata('THROTTLER:SKIPdefault', LiveController.prototype.events)).toBe(true);
  });
});
