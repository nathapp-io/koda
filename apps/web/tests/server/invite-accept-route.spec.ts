/**
 * US-007 — Nitro accept proxy (`server/api/invites/[token]/accept.post.ts`).
 *
 * The route relies on Nitro auto-imports (defineEventHandler, readBody,
 * forwardToApi, unwrapAuth, setAuthCookies, createError). ts-jest compiles it
 * with isolatedModules, so the module is importable and those names resolve from
 * globalThis at call time — the same seam tests/server/forward-to-api.spec.ts uses.
 */
import { describe, test, expect, jest, beforeEach } from '@jest/globals'
import { existsSync } from 'fs'
import { join } from 'path'

const routePath = join(__dirname, '..', '..', 'server', 'api', 'invites', '[token]', 'accept.post.ts')
const g = globalThis as Record<string, unknown>

const makeEvent = (token = 'tok123') => ({ context: { params: { token } } })

type Handler = (event: unknown) => Promise<unknown>

beforeEach(() => {
  // RED guard: the route must exist before behaviour can be exercised.
  expect(existsSync(routePath)).toBe(true)
  g.defineEventHandler = (handler: unknown) => handler
  g.readBody = async () => ({ name: 'Jane Doe', password: 'Secret123!' })
  g.forwardToApi = jest.fn(async () => ({ status: 201, body: { accessToken: 'at-1', refreshToken: 'rt-1' } }))
  g.unwrapAuth = (body: unknown) => body
  g.setAuthCookies = jest.fn()
  g.createError = (input: unknown) => Object.assign(new Error('createError'), input)
  g.getRouterParam = (event: unknown, name: string) =>
    (event as { context?: { params?: Record<string, string> } })?.context?.params?.[name]
})

describe('invite accept Nitro route (US-007)', () => {
  test('AC13: calls setAuthCookies with the tokens forwardToApi returned for /invites/<token>/accept', async () => {
    expect(existsSync(routePath)).toBe(true)
    const event = makeEvent('tok123')
    const { default: handler } = await import(routePath) as { default: Handler }

    await handler(event)

    const forward = g.forwardToApi as jest.Mock
    expect(forward.mock.calls[0]?.[1]).toBe('/invites/tok123/accept')
    expect(forward.mock.calls[0]?.[2]).toEqual({ method: 'POST', body: { name: 'Jane Doe', password: 'Secret123!' } })
    const setAuthCookies = g.setAuthCookies as jest.Mock
    expect(setAuthCookies).toHaveBeenCalledTimes(1)
    expect(setAuthCookies.mock.calls[0]).toEqual([event, { accessToken: 'at-1', refreshToken: 'rt-1' }])
  })

  test('AC13 boundary: an upstream error status sets no cookies and rethrows', async () => {
    g.forwardToApi = jest.fn(async () => ({ status: 409, body: { message: 'Email already registered' } }))
    const event = makeEvent('tok123')
    const { default: handler } = await import(routePath) as { default: Handler }

    await expect(handler(event)).rejects.toBeTruthy()

    expect(g.setAuthCookies as jest.Mock).not.toHaveBeenCalled()
  })
})
