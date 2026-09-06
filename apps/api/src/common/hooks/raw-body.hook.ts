import { Readable } from 'stream'

type FastifyAddHookFn = (
  name: 'preParsing',
  fn: (request: Record<string, unknown>, reply: unknown, payload: AsyncIterable<Buffer>) => Promise<unknown>,
) => void
type FastifyInstance = { addHook: FastifyAddHookFn }

/**
 * Registers a Fastify preParsing hook that captures the raw request body and
 * exposes it as `request.rawBody` for HMAC-verified webhooks (VCS + CI).
 *
 * Without this, controllers can only see the parsed object, which means a
 * signature computed over `JSON.stringify(payload)` may not match the
 * signature computed over the wire bytes (different key ordering,
 * whitespace, etc.).
 *
 * This must be registered BEFORE app.init() so the hook is wired into the
 * compiled route handlers.
 */
export function registerRawBodyHook(fastify: FastifyInstance): void {
  fastify.addHook('preParsing', async (request, _reply, payload) => {
    const ct = String((request['headers'] as Record<string, unknown> | undefined)?.['content-type'] ?? '')
    if (!ct.includes('application/json')) return payload

    const chunks: Buffer[] = []
    for await (const chunk of payload) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    }

    const body = chunks.length > 0 ? Buffer.concat(chunks) : Buffer.from('{}')

    const headers = request['headers'] as Record<string, unknown> | undefined
    if (headers) headers['content-length'] = String(body.length)
    request['rawBody'] = body

    return Readable.from([body])
  })
}

