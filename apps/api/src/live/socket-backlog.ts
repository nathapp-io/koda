interface SocketLike {
  writableLength?: unknown;
  destroy?: () => unknown;
}

/** The Fastify reply, as far as this module needs it: its raw Node response. */
export interface RawResponse {
  raw?: unknown;
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

/**
 * Return a live check of one client's queued, unsent bytes. `res` is the request's raw HTTP response:
 * the api runs under Bun in production, where a response buffers its own writes and the socket's
 * `writableLength` stays 0 however much is queued (koda #538), so the response is read first and the
 * socket stays the reading the spec names for a plain Node request.
 */
export function socketHasBacklog(req: unknown, res?: unknown): () => boolean {
  return () => hasUnsentBytes(res) || hasUnsentBytes(requestSocket(req));
}

function hasUnsentBytes(target: unknown): boolean {
  if (!isRecord(target)) return false;
  const length = (target as SocketLike).writableLength;
  return typeof length === 'number' && length > 0;
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
