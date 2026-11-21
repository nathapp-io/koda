import { afterEach, describe, expect, jest, test } from '@jest/globals'
import { setAuthCookies } from '~/server/utils/api'

const fixedNow = 1_700_000_000_000
const jwt = (exp: unknown) => `header.${Buffer.from(JSON.stringify({ exp })).toString('base64url')}.signature`

type Options = { httpOnly?: boolean; secure?: boolean; path?: string; sameSite?: string; maxAge?: number }

describe('setAuthCookies lifetime and policy', () => {
  const writes: Array<[unknown, string, string, Options]> = []
  const setCookie = jest.fn((...args: [unknown, string, string, Options]) => writes.push(args))
  const event = {}

  afterEach(() => {
    writes.length = 0
    setCookie.mockClear()
    delete (globalThis as Record<string, unknown>).setCookie
    jest.restoreAllMocks()
  })

  function invoke(tokens: { accessToken?: string; refreshToken?: string }) {
    const globals = globalThis as Record<string, unknown>
    globals.setCookie = setCookie
    jest.spyOn(Date, 'now').mockReturnValue(fixedNow)
    setAuthCookies(event as Parameters<typeof setAuthCookies>[0], tokens)
  }

  function ages() { return writes.map(([, name, , options]) => [name, options.maxAge]) }

  test('AC-1 sets remaining JWT ages and secure cookie attributes', () => {
    invoke({ accessToken: jwt(fixedNow / 1000 + 300), refreshToken: jwt(fixedNow / 1000 + 1_209_600) })
    expect(ages()).toEqual([['koda_token', 300], ['koda_refresh', 1_209_600]])
    expect(writes.map(([, name, , options]) => [name, options])).toEqual([
      ['koda_token', { httpOnly: true, sameSite: 'lax', secure: true, path: '/', maxAge: 300 }],
      ['koda_refresh', { httpOnly: true, sameSite: 'strict', secure: true, path: '/', maxAge: 1_209_600 }],
    ])
  })

  test('AC-2 uses defaults at issue time, zero for expired JWTs and skips absent tokens', () => {
    invoke({ accessToken: jwt(fixedNow / 1000 + 900), refreshToken: jwt(fixedNow / 1000 + 604_800) })
    expect(ages()).toEqual([['koda_token', 900], ['koda_refresh', 604_800]])
    writes.length = 0
    invoke({ accessToken: jwt(fixedNow / 1000 - 1), refreshToken: jwt(fixedNow / 1000 - 1) })
    expect(ages()).toEqual([['koda_token', 0], ['koda_refresh', 0]])
    writes.length = 0
    invoke({ accessToken: 'access-only' })
    expect(writes.map(([, name]) => name)).toEqual(['koda_token'])
    writes.length = 0
    invoke({ refreshToken: 'refresh-only' })
    expect(writes.map(([, name]) => name)).toEqual(['koda_refresh'])
    writes.length = 0
    invoke({})
    expect(writes).toEqual([])
  })

  test('AC-3 uses independent per-cookie fallback ages for opaque JWTs', () => {
    invoke({ accessToken: 'opaque-access', refreshToken: jwt(fixedNow / 1000 + 500) })
    expect(ages()).toEqual([['koda_token', 900], ['koda_refresh', 500]])
    writes.length = 0
    invoke({ refreshToken: 'opaque-refresh' })
    expect(ages()).toEqual([['koda_refresh', 604_800]])
  })

  test('AC-6 uses fallback for a string-valued expiry', () => {
    invoke({ accessToken: jwt('1700000100'), refreshToken: jwt('invalid') })
    expect(ages()).toEqual([['koda_token', 900], ['koda_refresh', 604_800]])
  })
})
