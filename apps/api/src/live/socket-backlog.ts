interface SocketLike {
  writableLength?: unknown;
  destroy?: () => unknown;
}

interface RequestLike {
  raw?: { socket?: SocketLike };
  socket?: SocketLike;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** The request's own socket: `raw.socket` for a Fastify request, `socket` for a plain Node request. */
function requestSocket(req: unknown): SocketLike | undefined {
  if (!isRecord(req)) return undefined;
  const request = req as RequestLike;
  return request.raw?.socket ?? request.socket;
}

/** Return a live check of the request socket's queued, unsent bytes. */
export function socketHasBacklog(req: unknown): () => boolean {
  return () => {
    const socket = requestSocket(req);
    return typeof socket?.writableLength === 'number' && socket.writableLength > 0;
  };
}

/**
 * Drops the client's connection (review B1). Completing the producer is not enough for a client that is not reading:
 * Nest holds the events already queued for it and waits for those writes before it ends the response, so the stream
 * and its queue would be retained until TCP times out. Destroying the socket discards both and lets Nest's own `close`
 * handling unsubscribe its write pipeline and settle the response. A browser `EventSource` reconnects by itself.
 */
export function destroyRequestSocket(req: unknown): void {
  const socket = requestSocket(req);
  if (typeof socket?.destroy === 'function') socket.destroy();
}
