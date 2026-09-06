import { Readable } from 'stream'

type FastifyAddHookFn = (
  name: 'preParsing',
  fn: (request: Record<string, unknown>, reply: unknown, payload: AsyncIterable<Buffer>) => Promise<unknown>,
) => void
type FastifyInstance = { addHook: FastifyAddHookFn }

export const DEFAULT_RAW_BODY_LIMIT_BYTES = 1 * 1024 * 1024 // 1 MiB

/**
 * Pre-parsing hook that:
 *  1. captures the raw request body bytes into `request.rawBody` so that
 *     downstream HMAC verifiers can re-compute the signature over the
 *     wire bytes (fixes KODA-02 — `JSON.stringify(parsedBody)` no longer
 *     matches the bytes GitHub actually signed);
 *  2. enforces a hard size cap before the JSON parser sees the buffer so
 *     a client streaming a multi-GB `application/json` body cannot
 *     exhaust server memory (fixes KODA-12 — the original preParsing
 *     hook drained the full stream into memory unconditionally).
 *
 * The hook only buffers application/json requests; all other content
 * types fall through unchanged so the framework parser sees the stream.
 */
export function registerRawBodyHook(
  fastify: FastifyInstance,
  options: { maxBytes?: number } = {},
): void {
  const maxBytes = options.maxBytes ?? DEFAULT_RAW_BODY_LIMIT_BYTES

  fastify.addHook('preParsing', async (request, reply, payload) => {
    const ct = String((request['headers'] as Record<string, unknown> | undefined)?.['content-type'] ?? '')
    if (!ct.includes('application/json')) return payload

    const chunks: Buffer[] = []
    let totalBytes = 0
    let rejected = false

    for await (const chunk of payload) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      totalBytes += buf.length
      if (totalBytes > maxBytes) {
        rejected = true
        // Drain the rest of the stream so the socket doesn't leak, but
        // don't keep buffering.
        for await (const _ of payload) { /* no-op drain */ }
        break
      }
      chunks.push(buf)
    }

    if (rejected) {
      const replyLike = reply as { code?: (n: number) => unknown; send?: (s: string) => unknown }
      replyLike.code?.(413)
      replyLike.send?.('Request body too large')
      const err = new Error('Request body too large') as Error & { statusCode?: number; status?: string; fatal?: boolean }
      err.statusCode = 413
      err.status = 'PAYLOAD_TOO_LARGE'
      err.fatal = true
      throw err
    }

    const body = chunks.length > 0 ? Buffer.concat(chunks) : Buffer.from('{}')

    const headers = request['headers'] as Record<string, unknown> | undefined
    if (headers) headers['content-length'] = String(body.length)
    request['rawBody'] = body

    return Readable.from([body])
  })
}
