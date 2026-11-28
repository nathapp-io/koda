interface SocketLike {
  writableLength?: unknown;
}

interface RequestLike {
  raw?: { socket?: SocketLike };
  socket?: SocketLike;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Return a live check of the request socket's queued, unsent bytes. */
export function socketHasBacklog(req: unknown): () => boolean {
  return () => {
    if (!isRecord(req)) return false;
    const request = req as RequestLike;
    const socket = request.raw?.socket ?? request.socket;
    return typeof socket?.writableLength === 'number' && socket.writableLength > 0;
  };
}
