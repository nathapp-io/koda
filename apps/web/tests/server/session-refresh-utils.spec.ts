import { describe, expect, test } from '@jest/globals'
import { ACCESS_COOKIE } from '~/server/utils/api'

import { shouldRefreshSession, withAuthCookies } from '~/server/utils/session-refresh'

const jwt = (exp: unknown) => `header.${Buffer.from(JSON.stringify({ exp })).toString('base64url')}.signature`

function event(method: string, url: string, accept: string, cookie?: string) {
  return {
    node: {
      req: {
        method,
        url,
        headers: {
          accept,
          ...(cookie ? { cookie } : {}),
        },
      },
    },
  }
}

describe('shouldRefreshSession', () => {
  test('refreshes an HTML GET when only the refresh cookie exists (AC-1)', () => {
    expect(shouldRefreshSession(event('GET', '/projects', 'text/html', 'koda_refresh=r1'))).toBe(true)
  })

  test('AC-4 refreshes when access JWT is expired, but not when it remains valid', () => {
    const now = 1_700_000_000_000
    jest.spyOn(Date, 'now').mockReturnValue(now)
    expect(shouldRefreshSession(event('GET', '/projects', 'text/html', `koda_refresh=r1; ${ACCESS_COOKIE}=${jwt(now / 1000 - 1)}`))).toBe(true)
    expect(shouldRefreshSession(event('GET', '/projects', 'text/html', `koda_refresh=r1; ${ACCESS_COOKIE}=${jwt(now / 1000 + 1)}`))).toBe(false)
    jest.restoreAllMocks()
  })

  test('AC-6 keeps opaque access cookies ineligible', () => {
    expect(shouldRefreshSession(event('GET', '/projects', 'text/html', 'koda_refresh=r1; koda_token=opaque'))).toBe(false)
  })

  test.each([
    ['access cookie exists', event('GET', '/projects', 'text/html', 'koda_refresh=r1; koda_token=a1')],
    ['refresh cookie is absent', event('GET', '/projects', 'text/html')],
    ['API request', event('GET', '/api/projects', 'text/html', 'koda_refresh=r1')],
    ['non-GET request', event('POST', '/projects', 'text/html', 'koda_refresh=r1')],
    ['non-HTML request', event('GET', '/favicon.ico', 'image/*', 'koda_refresh=r1')],
  ])('does not refresh when %s (AC-2–AC-6)', (_reason, request) => {
    expect(shouldRefreshSession(request)).toBe(false)
  })
})

describe('withAuthCookies', () => {
  test('replaces refresh, adds access, and preserves other cookies once (AC-7)', () => {
    const result = withAuthCookies('koda_refresh=r1; koda_locale=zh', { accessToken: 'a2', refreshToken: 'r2' })
    const cookies = result.split(';').map((part) => part.trim())
    expect(cookies).toHaveLength(3)
    expect(cookies.sort()).toEqual(['koda_refresh=r2', 'koda_locale=zh', 'koda_token=a2'].sort())
  })

  test('adds both auth cookies when the request has no cookie header (AC-8)', () => {
    const result = withAuthCookies(undefined, { accessToken: 'a2', refreshToken: 'r2' })
    const cookies = result.split(';').map((part) => part.trim())
    expect(cookies).toHaveLength(2)
    expect(cookies.sort()).toEqual(['koda_token=a2', 'koda_refresh=r2'].sort())
  })
})
