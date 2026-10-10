import { ForbiddenAppException, ThrottleAppException } from '@nathapp/nestjs-common';
import { firstValueFrom, take, toArray } from 'rxjs';
import type { JwtAuthProvider } from '../auth/jwt-auth.provider';
import type { KodaPrincipal } from '../auth/principal/koda-principal.types';
import { LiveStreamRegistry } from './live-stream-registry';
import { MeLiveController } from './me-live.controller';
import { UserEventBus } from './user-event-bus';

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

function setup(revoked = false) {
  const jwtAuth = { getPrincipal: vi.fn().mockResolvedValue({ ...user, revoked }) } as unknown as JwtAuthProvider;
  const bus = new UserEventBus();
  const streams = new LiveStreamRegistry();
  const controller = new MeLiveController(bus, streams, jwtAuth, { heartbeatMs: 25000, maxStreamsPerUser: 5 });
  const req = { headers: { authorization: `Bearer ${jwtFor({ sub: 'u1', tokenVersion: 0, exp: Math.floor(Date.now() / 1000) + 900 })}` } };
  return { controller, jwtAuth, bus, streams, req };
}

describe('MeLiveController (S4a §4)', () => {
  it('refuses agent principals with 403', async () => {
    const { controller, req } = setup();
    await expect(controller.events(agent, req)).rejects.toBeInstanceOf(ForbiddenAppException);
  });

  it('refuses a request without a readable bearer token', async () => {
    const { controller } = setup();
    await expect(controller.events(user, { headers: {} })).rejects.toBeInstanceOf(ForbiddenAppException);
  });

  it('shares the per-user cap with project streams: a 6th stream is 429', async () => {
    const { controller, streams, req } = setup();
    for (let i = 0; i < 5; i += 1) streams.tryAcquire('u1', 5);
    await expect(controller.events(user, req)).rejects.toBeInstanceOf(ThrottleAppException);
  });

  it('streams ready then the caller\'s notification events only, and releases the slot', async () => {
    const { controller, bus, streams, req } = setup();
    const stream = await controller.events(user, req);
    expect(streams.activeFor('u1')).toBe(1);
    const firstTwo = firstValueFrom(stream.pipe(take(2), toArray()));
    bus.publish({ type: 'notification', userId: 'someone-else', id: 'n0', at: 'x' });
    bus.publish({ type: 'notification', userId: 'u1', id: 'n1', at: 'x' });
    const messages = await firstTwo;
    expect(messages.map((m) => m.type)).toEqual(['ready', 'notification']);
    expect(messages[1]).toEqual({ type: 'notification', id: 'n1', data: { type: 'notification', userId: 'u1', id: 'n1', at: 'x' } });
    expect(streams.activeFor('u1')).toBe(0);
  });

  it('closes the stream when the fresh principal is revoked (disabled or logged out)', async () => {
    vi.useFakeTimers();
    try {
      const { controller, req } = setup(true);
      const stream = await controller.events(user, req);
      let completed = false;
      const sub = stream.subscribe({ complete: () => { completed = true; } });
      await vi.advanceTimersByTimeAsync(25000);
      expect(completed).toBe(true);
      sub.unsubscribe();
    } finally {
      vi.useRealTimers();
    }
  });
});
