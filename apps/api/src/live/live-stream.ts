import type { MessageEvent } from '@nestjs/common';
import { Observable } from 'rxjs';
import type { LiveEvent } from './live-event';

const MAX_TIMER_MS = 2_147_483_647;

export interface LiveStreamOptions {
  projectId: string;
  heartbeatMs: number;
  expiresAtMs: number | null;
  now: () => number;
  subscribe: (projectId: string, listener: (event: LiveEvent) => void) => () => void;
  stillAllowed: () => Promise<boolean>;
  onClose: () => void;
}

/**
 * One member's live stream. Sends `ready` at once so the client sees the
 * stream open immediately, forwards bus events as `ticket` events,
 * re-checks access on every heartbeat (`ping` when it holds), and completes on
 * lost access or token expiry. Teardown runs once, on client close or
 * completion.
 */
export function createLiveStream(options: LiveStreamOptions): Observable<MessageEvent> {
  return new Observable<MessageEvent>((subscriber) => {
    let done = false;
    let checking = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      subscriber.complete();
    };

    subscriber.next({ type: 'ready', data: {} });
    const unsubscribe = options.subscribe(options.projectId, (event) => {
      if (!done) subscriber.next({ type: event.type, id: event.id, data: event });
    });

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
    }, options.heartbeatMs);

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
