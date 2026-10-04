import type { Readable } from 'stream';

/** Read and discard past the cap up to this multiple, so the 413 reaches the client (destroying the request resets the socket). */
const DRAIN_FACTOR = 4;

/** Spec §2.2 step 5: Fastify does not meter a raw stream, so count here. */
export async function readCappedBody(stream: Readable, maxBytes: number): Promise<{ ok: 'yes'; bytes: Buffer } | { ok: 'too_large' }> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    total += buffer.length;
    if (total > maxBytes * DRAIN_FACTOR) {
      stream.destroy(); // a hostile body: give up on a clean 413
      return { ok: 'too_large' };
    }
    if (total <= maxBytes) chunks.push(buffer);
  }
  return total > maxBytes ? { ok: 'too_large' } : { ok: 'yes', bytes: Buffer.concat(chunks, total) };
}
