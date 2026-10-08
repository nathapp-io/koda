import type { MessageEvent } from '@nestjs/common';
import { Observable } from 'rxjs';
import type { LiveEvent } from './live-event';

const MAX_TIMER_MS = 2_147_483_647;

/** What a stream forwards: a named, id-carrying event (clients dedupe on id). */
export interface LiveStreamEvent {
  type: string;
  id: string;
}

export interface LiveStreamOptions<E extends LiveStreamEvent = LiveEvent> {
  /** Bus key: a project id for project streams, a user id for `/me/events` (S4a §4). */
  key: string;
  heartbeatMs: number;
  expiresAtMs: number | null;
  now: () => number;
  subscribe: (key: string, listener: (event: E) => void) => () => void;
  stillAllowed: () => Promise<boolean>;
  onClose: () => void;
}

/**
 * One caller's live stream (project or user). Sends `ready` at once so the client sees the
 * stream open immediately, forwards bus events as `ticket` events,
 * re-checks access on every heartbeat (`ping` when it holds), and completes on
 * lost access or token expiry. Teardown runs once, on client close or
 * completion.
 */
export function createLiveStream<E extends LiveStreamEvent = LiveEvent>(options: LiveStreamOptions<E>): Observable<MessageEvent> {
  return new Observable<MessageEvent>((subscriber) => {
    let done = false;
    let checking = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      subscriber.complete();
    };

    subscriber.next({ type: 'ready', data: {} });
    const unsubscribe = options.subscribe(options.key, (event) => {
      if (!done) subscriber.next({ type: event.type, id: event.id, data: event });
    });

    // Same overflow clamp as the expiry timer: Node collapses delays above
    // 2^31-1 ms to 1 ms, which would hammer the access check.
    const heartbeat = setInterval(() => {
      if (done || checking) return;
      checking = true;
      options
        .stillAllowed()
        .catch(() => false)
        .then((allowed) => {
          checking = false;
          if (done) return;
          if (allowed) subscriber.next({ type: 'ping', data: {} });
          else finish();
        });
    }, Math.min(MAX_TIMER_MS, options.heartbeatMs));

    // setTimeout overflows above 2^31-1 ms (about 24.8 days) and would fire at once.
    const expiry = options.expiresAtMs === null
      ? null
      : setTimeout(finish, Math.min(MAX_TIMER_MS, Math.max(0, options.expiresAtMs - options.now())));

    return () => {
      done = true;
      clearInterval(heartbeat);
      if (expiry !== null) clearTimeout(expiry);
      unsubscribe();
      options.onClose();
    };
  });
}
