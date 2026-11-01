import { describe, expect, test } from '@jest/globals'
import { shouldRefreshSession, withAuthCookies } from '~/server/utils/session-refresh'

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
