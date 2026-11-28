import type { MessageEvent } from '@nestjs/common';
import type { Observable } from 'rxjs';
import { EventEmitter } from 'node:events';
import { Writable } from 'node:stream';
import { RouterResponseController } from '@nestjs/core/router/router-response-controller';
import { createLiveStream, type LiveStreamOptions } from './live-stream';
import type { LiveEvent } from './live-event';
import { LiveController } from './live.controller';
import { MeLiveController } from './me-live.controller';
import { LiveStreamRegistry } from './live-stream-registry';
import { ProjectEventBus } from './project-event-bus';
import { UserEventBus } from './user-event-bus';
import { ThreadEventBus } from './thread-event-bus';
import { ThreadEventsController } from '../fleet/threads/thread-events.controller';
import { WorkspaceThreadEventsController } from '../fleet/threads/workspace-thread-events.controller';
import type { KodaPrincipal, UserPrincipal } from '../auth/principal/koda-principal.types';
import type { ProjectAccessService } from '../projects/project-access.service';
import type { JwtAuthProvider } from '../auth/jwt-auth.provider';
import type { PermissionService } from '../permissions/permission.service';
import type { ILiveConfig } from '../config/live.config';

const principal: UserPrincipal = { actorType: 'user', id: 'u1', role: 'MEMBER', email: 'u1@koda.test' };
const encoded = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url');
const bearer = `Bearer ${encoded({ alg: 'HS256' })}.${encoded({ sub: 'u1', exp: 1_800_000_000 })}.sig`;
const cfg: ILiveConfig = { heartbeatMs: 10, maxStreamsPerUser: 5 };

function observe(stream: Observable<MessageEvent>) {
  let complete = false;
  const sub = stream.subscribe({ complete: () => { complete = true; } });
  return { completed: () => complete, unsubscribe: () => sub.unsubscribe() };
}

function streamOptions(overrides: Partial<LiveStreamOptions> = {}): LiveStreamOptions {
  return {
    key: 'p1', heartbeatMs: 10, expiresAtMs: null, now: () => 0,
    subscribe: vi.fn(() => vi.fn()), stillAllowed: vi.fn().mockResolvedValue(true), onClose: vi.fn(),
    ...overrides,
  };
}

/** A client socket that stopped reading: it reports unsent bytes and drops the connection when destroyed. */
class StalledSocket extends EventEmitter {
  writableLength = 5;
  destroyed = false;
  setKeepAlive(): void {}
  setNoDelay(): void {}
  setTimeout(): void {}
  override destroy(): void {
    this.destroyed = true;
    this.emit('close');
  }
}

/** A response that never drains: every write stays pending, as one to a client that stopped reading does. */
class StalledResponse extends Writable {
  statusCode = 200;
  writeHead(): this {
    return this;
  }
  flushHeaders(): void {}
  override _write(): void {
    // Never calls back: the socket's send buffer stays full.
  }
}

describe('createLiveStream stalled-client handling', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('AC-1: completes on the second consecutive stalled heartbeat and closes once', async () => {
    const options = streamOptions({ isStalled: () => true });
    let complete = false;
    createLiveStream(options).subscribe({ complete: () => { complete = true; } });
    await vi.advanceTimersByTimeAsync(20);
    expect(complete).toBe(true);
    expect(options.onClose).toHaveBeenCalledTimes(1);
  });

  it('AC-2: checks access on the first stalled tick but not the second', async () => {
    const options = streamOptions({ isStalled: () => true });
    const sub = createLiveStream(options).subscribe();
    await vi.advanceTimersByTimeAsync(10);
    expect(options.stillAllowed).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(10);
    expect(options.stillAllowed).toHaveBeenCalledTimes(1);
    sub.unsubscribe();
  });

  it('AC-3: emits no ping on the second stalled tick', async () => {
    const messages: MessageEvent[] = [];
    const sub = createLiveStream(streamOptions({ isStalled: () => true })).subscribe((event) => messages.push(event));
    await vi.advanceTimersByTimeAsync(20);
    expect(messages.filter(({ type }) => type === 'ping')).toHaveLength(1);
    sub.unsubscribe();
  });

  it('AC-4: a non-stalled reading resets the consecutive count', async () => {
    const readings = [true, false, true, true];
    const isStalled = vi.fn(() => readings.shift() ?? true);
    let complete = false;
    const sub = createLiveStream(streamOptions({ isStalled })).subscribe({ complete: () => { complete = true; } });
    await vi.advanceTimersByTimeAsync(30);
    expect(isStalled).toHaveBeenCalledTimes(3);
    expect(complete).toBe(false);
    await vi.advanceTimersByTimeAsync(10);
    expect(isStalled).toHaveBeenCalledTimes(4);
    expect(complete).toBe(true);
    sub.unsubscribe();
  });

  it('AC-5: without a stalled check, three heartbeats still ping and stay open', async () => {
    const messages: MessageEvent[] = [];
    let complete = false;
    const sub = createLiveStream(streamOptions()).subscribe({ next: (event) => messages.push(event), complete: () => { complete = true; } });
    await vi.advanceTimersByTimeAsync(30);
    expect(messages.filter(({ type }) => type === 'ping')).toHaveLength(3);
    expect(complete).toBe(false);
    sub.unsubscribe();
  });
});

describe.each([
  { source: 'socket', socketBytes: 5, responseBytes: 0 },
  // Bun buffers on the response only: omitting reply.raw must break every route's case.
  { source: 'response (Bun)', socketBytes: 0, responseBytes: 5 },
])('SSE controller stalled-client wiring: $source backlog', ({ socketBytes, responseBytes }) => {
  let streams: LiveStreamRegistry;
  let socket: { writableLength: number; destroy: ReturnType<typeof vi.fn> };
  let reply: { raw: { writableLength: number } };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    streams = new LiveStreamRegistry();
    socket = { writableLength: socketBytes, destroy: vi.fn() };
    reply = { raw: { writableLength: responseBytes } };
  });
  afterEach(() => vi.useRealTimers());

  async function completesAfterTwoHeartbeats(makeStream: () => Promise<Observable<MessageEvent>>) {
    const stream = await makeStream();
    const observed = observe(stream);
    try {
      expect(streams.activeFor(principal.id)).toBe(1);
      await vi.advanceTimersByTimeAsync(cfg.heartbeatMs);
      expect(observed.completed()).toBe(false);
      expect(socket.destroy).not.toHaveBeenCalled();
      expect(streams.activeFor(principal.id)).toBe(1);

      await vi.advanceTimersByTimeAsync(cfg.heartbeatMs);
      expect(observed.completed()).toBe(true);
      expect(socket.destroy).toHaveBeenCalledTimes(1);
      expect(streams.activeFor(principal.id)).toBe(0);
    } finally {
      observed.unsubscribe();
    }
  }

  it('AC-10: LiveController.events closes for persistent backlog', async () => {
    const access = { findProjectIdBySlug: vi.fn().mockResolvedValue('p1'), assertProjectMembership: vi.fn().mockResolvedValue(undefined) };
    const controller = new LiveController(access as unknown as ProjectAccessService, new ProjectEventBus(), streams, { getPrincipal: vi.fn().mockResolvedValue({ revoked: false }) } as unknown as JwtAuthProvider, cfg);
    const req = { headers: { authorization: bearer }, raw: { socket } };
    await completesAfterTwoHeartbeats(() => controller.events('p1', principal as KodaPrincipal, req, reply));
  });

  it('AC-11: MeLiveController.events closes for persistent backlog', async () => {
    const controller = new MeLiveController(new UserEventBus(), streams, { getPrincipal: vi.fn().mockResolvedValue({ revoked: false }) } as unknown as JwtAuthProvider, cfg);
    const req = { headers: { authorization: bearer }, raw: { socket } };
    await completesAfterTwoHeartbeats(() => controller.events(principal, req, reply));
  });

  it('AC-12: ThreadEventsController.events closes for persistent backlog', async () => {
    streams.tryAcquire(principal.id, cfg.maxStreamsPerUser);
    const controller = new ThreadEventsController(
      { assertProjectMembership: vi.fn().mockResolvedValue(undefined) } as unknown as ProjectAccessService,
      new ThreadEventBus(), streams,
      { getPrincipal: vi.fn().mockResolvedValue({ revoked: false }) } as unknown as JwtAuthProvider,
      cfg, { can: vi.fn().mockResolvedValue({ allowed: true }) } as unknown as PermissionService,
    );
    const req = { params: { slug: 'p1', id: 't1' }, threadEvents: { projectId: 'p1', jwtPayload: { sub: 'u1', exp: 1_800_000_000 } }, raw: { socket } };
    await completesAfterTwoHeartbeats(() => controller.events('t1', principal, req, reply));
  });

  it('AC-13: WorkspaceThreadEventsController.events closes for persistent backlog', async () => {
    streams.tryAcquire(principal.id, cfg.maxStreamsPerUser);
    const controller = new WorkspaceThreadEventsController(new ThreadEventBus(), streams, { getPrincipal: vi.fn().mockResolvedValue({ revoked: false }) } as unknown as JwtAuthProvider, cfg);
    const req = { params: { id: 't1' }, workspaceThreadEvents: { jwtPayload: { sub: 'u1', exp: 1_800_000_000 } }, raw: { socket } };
    await completesAfterTwoHeartbeats(() => controller.events('t1', principal, req, reply));
  });
});

/**
 * Review B1: completing the producer is not enough. Nest's SSE pipeline (`concatMap` over one write per event) waits
 * for the writes already queued for a client that is not draining, so the queue and the connection survive the
 * stream's completion. Driven through the installed `RouterResponseController` with a writable that never drains.
 */
describe('stalled SSE teardown through Nest response handling', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('B1: the connection is dropped and the response settles instead of retaining queued events', async () => {
    const access = { findProjectIdBySlug: vi.fn().mockResolvedValue('p1'), assertProjectMembership: vi.fn().mockResolvedValue(undefined) };
    const controller = new LiveController(access as unknown as ProjectAccessService, new ProjectEventBus(), new LiveStreamRegistry(), { getPrincipal: vi.fn().mockResolvedValue({ revoked: false }) } as unknown as JwtAuthProvider, cfg);
    const socket = new StalledSocket();
    const req = { headers: { authorization: bearer }, raw: { socket } };
    const response = new StalledResponse();
    const router = new RouterResponseController({} as never);

    const served = router.sse(controller.events('p1', principal as KodaPrincipal, req), response, req as never, {});
    await vi.advanceTimersByTimeAsync(20);

    expect(socket.destroyed).toBe(true);
    await expect(served).resolves.toBeUndefined();
    expect(response.writableEnded).toBe(true);
  });
});
