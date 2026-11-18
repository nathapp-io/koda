import { describe, test, expect, jest, beforeEach } from '@jest/globals'
import { join } from 'path'

const routePath = join(__dirname, '..', '..', 'server', 'api', 'auth', 'me.get.ts')
const g = globalThis as Record<string, unknown>
type Handler = (event: unknown) => Promise<unknown>

beforeEach(() => {
  g.ACCESS_COOKIE = 'koda_token'
  g.defineEventHandler = (handler: unknown) => handler
  g.createError = (input: unknown) => Object.assign(new Error('unavailable'), input)
  g.getCookie = (_event: unknown, name: string) => name === 'koda_token' ? 'access-token' : undefined
})

describe('GET /api/auth/me outage classification', () => {
  test.each([401, 403])('returns no user for upstream %i', async (status) => {
    const forward = jest.fn(async () => ({ status, body: {} }))
    g.forwardToApi = forward
    const { default: handler } = await import(routePath) as { default: Handler }
    expect(await handler({ node: { res: { setHeader: jest.fn() } } })).toEqual({ user: null })
  })

  test.each([502, 429])('throws 503 for upstream %i without mutating cookies', async (status) => {
    const headers: Record<string, string> = {}
    const event = { node: { res: { setHeader: (name: string, value: string) => { headers[name] = value } } } }
    g.forwardToApi = jest.fn(async () => ({ status, body: {} }))
    const { default: handler } = await import(routePath) as { default: Handler }
    await expect(handler(event)).rejects.toMatchObject({ statusCode: 503 })
    expect(headers).not.toHaveProperty('Set-Cookie')
  })

  test('maps network failure to 503 without mutating cookies', async () => {
    const event = { node: { res: { setHeader: jest.fn() } } }
    g.forwardToApi = jest.fn(async () => { throw new Error('network failure') })
    const { default: handler } = await import(routePath) as { default: Handler }
    await expect(handler(event)).rejects.toMatchObject({ statusCode: 503 })
    expect(event.node.res.setHeader).not.toHaveBeenCalled()
  })

  test('does not call upstream without an access cookie', async () => {
    g.getCookie = () => undefined
    const forward = jest.fn()
    g.forwardToApi = forward
    const { default: handler } = await import(routePath) as { default: Handler }
    expect(await handler({})).toEqual({ user: null })
    expect(forward).not.toHaveBeenCalled()
  })
})
