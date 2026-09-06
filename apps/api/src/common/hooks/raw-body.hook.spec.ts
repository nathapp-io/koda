import { Readable } from 'stream'
import { DEFAULT_RAW_BODY_LIMIT_BYTES, registerRawBodyHook } from './raw-body.hook'

type HookRequest = Record<string, unknown> & { headers: Record<string, string>; rawBody?: Buffer }

type CapturedPayload = {
  hook: (request: HookRequest, reply: unknown, payload: AsyncIterable<Buffer>) => Promise<unknown>
}

function makeFastify(recorder: CapturedPayload): {
  addHook: (
    name: 'preParsing',
    fn: (request: HookRequest, reply: unknown, payload: AsyncIterable<Buffer>) => Promise<unknown>,
  ) => void
} {
  return {
    addHook: (_name, fn) => {
      recorder.hook = fn
    },
  }
}

function asPayload(buffer: Buffer): AsyncIterable<Buffer> {
  return Readable.from([buffer])
}

function replySpy(): { code: jest.Mock; send: jest.Mock } {
  return { code: jest.fn().mockReturnThis(), send: jest.fn() }
}

function makeRequest(headers: Record<string, string>): HookRequest {
  return { headers } as unknown as HookRequest
}

describe('registerRawBodyHook', () => {
  it('passes through non-JSON content types without buffering', async () => {
    const recorder: CapturedPayload = { hook: async () => undefined }
    registerRawBodyHook(makeFastify(recorder) as never)
    const passthrough = asPayload(Buffer.from('hello'))

    const request = makeRequest({ 'content-type': 'text/plain' })
    const result = await recorder.hook(request, replySpy(), passthrough)

    expect(result).toBe(passthrough)
    expect(request).not.toHaveProperty('rawBody')
  })

  it('captures rawBody bytes from JSON content and exposes them on the request', async () => {
    const recorder: CapturedPayload = { hook: async () => undefined }
    registerRawBodyHook(makeFastify(recorder) as never)

    const request = makeRequest({ 'content-type': 'application/json' })
    const payload = asPayload(Buffer.from('{"a":1}'))
    const result = await recorder.hook(request, replySpy(), payload)

    expect(request.rawBody).toEqual(Buffer.from('{"a":1}'))
    expect(request.headers?.['content-length']).toBe('7')
    expect(Buffer.isBuffer(result) || result instanceof Readable).toBe(true)
  })

  it('falls back to empty {} when no JSON body is sent', async () => {
    const recorder: CapturedPayload = { hook: async () => undefined }
    registerRawBodyHook(makeFastify(recorder) as never)

    const request = makeRequest({ 'content-type': 'application/json' })
    await recorder.hook(request, replySpy(), Readable.from([]))

    expect(request.rawBody).toEqual(Buffer.from('{}'))
  })

  it('default limit is 1 MiB', () => {
    expect(DEFAULT_RAW_BODY_LIMIT_BYTES).toBe(1024 * 1024)
  })

  it('rejects with 413 and drains the rest of the stream when body exceeds the configured cap', async () => {
    const recorder: CapturedPayload = { hook: async () => undefined }
    registerRawBodyHook(makeFastify(recorder) as never, { maxBytes: 8 })

    const request = makeRequest({ 'content-type': 'application/json' })
    const reply = replySpy()

    // The first chunk is 4 bytes (passes), the second 4 bytes would push past
    // the 8-byte cap and the rest of the stream is consumed to avoid leaks.
    async function* chunks() {
      yield Buffer.from('1234')
      yield Buffer.from('5678')
      yield Buffer.from('9012')
    }

    await expect(
      recorder.hook(request, reply, chunks() as unknown as AsyncIterable<Buffer>),
    ).rejects.toMatchObject({
      statusCode: 413,
      fatal: true,
    })
    expect(reply.code).toHaveBeenCalledWith(413)
    expect(reply.send).toHaveBeenCalledWith('Request body too large')
  })

  it('respects a custom maxBytes option', async () => {
    const recorder: CapturedPayload = { hook: async () => undefined }
    registerRawBodyHook(makeFastify(recorder) as never, { maxBytes: 4 })

    const request = makeRequest({ 'content-type': 'application/json' })
    await recorder.hook(request, replySpy(), asPayload(Buffer.from('12')))
    expect(request.rawBody).toEqual(Buffer.from('12'))

    const rejected = recorder.hook(
      makeRequest({ 'content-type': 'application/json' }),
      replySpy(),
      asPayload(Buffer.from('12345')),
    )
    await expect(rejected).rejects.toMatchObject({ statusCode: 413 })
  })
})
