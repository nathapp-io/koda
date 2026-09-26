/**
 * Minimal streaming SSE reader for integration tests (supertest buffers the
 * whole response, which never ends for a live stream).
 */
export interface SseMessage {
  event: string;
  id?: string;
  data: string;
}

export interface SseConnection {
  status: number;
  body: string;
  next(predicate: (m: SseMessage) => boolean, timeoutMs?: number): Promise<SseMessage>;
  closed: Promise<void>;
  isClosed(): boolean;
  close(): void;
}

interface Waiter {
  predicate: (m: SseMessage) => boolean;
  resolve: (m: SseMessage) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

function parseBlock(block: string): SseMessage | null {
  const fields = block.split('\n').reduce<Record<string, string>>((acc, line) => {
    const idx = line.indexOf(':');
    if (idx <= 0) return acc;
    const key = line.slice(0, idx);
    const value = line.slice(idx + 1).replace(/^ /, '');
    return { ...acc, [key]: key === 'data' && acc['data'] !== undefined ? `${acc['data']}\n${value}` : value };
  }, {});
  if (fields['data'] === undefined && fields['event'] === undefined) return null;
  return { event: fields['event'] ?? 'message', id: fields['id'], data: fields['data'] ?? '' };
}

export async function openSse(url: string, token: string): Promise<SseConnection> {
  const controller = new AbortController();
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'text/event-stream' },
    signal: controller.signal,
  });
  if (!res.ok || !res.body) {
    const body = await res.text();
    return {
      status: res.status,
      body,
      next: () => Promise.reject(new Error(`stream not open (${res.status})`)),
      closed: Promise.resolve(),
      isClosed: () => true,
      close: () => undefined,
    };
  }

  let inbox: SseMessage[] = [];
  let waiters: Waiter[] = [];
  let ended = false;

  const deliver = (message: SseMessage): void => {
    const waiter = waiters.find((w) => w.predicate(message));
    if (!waiter) {
      inbox = [...inbox, message];
      return;
    }
    clearTimeout(waiter.timer);
    waiters = waiters.filter((w) => w !== waiter);
    waiter.resolve(message);
  };

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const closed = (async (): Promise<void> => {
    let buffer = '';
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let idx = buffer.indexOf('\n\n');
        while (idx >= 0) {
          const message = parseBlock(buffer.slice(0, idx));
          buffer = buffer.slice(idx + 2);
          if (message) deliver(message);
          idx = buffer.indexOf('\n\n');
        }
      }
    } catch {
      // aborted by close()
    } finally {
      ended = true;
      waiters.forEach((w) => {
        clearTimeout(w.timer);
        w.reject(new Error('stream closed'));
      });
      waiters = [];
    }
  })();

  return {
    status: res.status,
    body: '',
    next(predicate, timeoutMs = 3000) {
      const queued = inbox.find(predicate);
      if (queued) {
        inbox = inbox.filter((m) => m !== queued);
        return Promise.resolve(queued);
      }
      if (ended) return Promise.reject(new Error('stream closed'));
      return new Promise<SseMessage>((resolve, reject) => {
        const timer = setTimeout(() => {
          waiters = waiters.filter((w) => w.timer !== timer);
          reject(new Error(`no matching SSE message within ${timeoutMs} ms`));
        }, timeoutMs);
        waiters = [...waiters, { predicate, resolve, reject, timer }];
      });
    },
    closed,
    isClosed: () => ended,
    close: () => controller.abort(),
  };
}
