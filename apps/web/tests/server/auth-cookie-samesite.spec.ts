import { afterEach, describe, expect, jest, test } from '@jest/globals'
import { setAuthCookies } from '~/server/utils/api'

describe('setAuthCookies SameSite policy', () => {
  afterEach(() => { delete (globalThis as Record<string, unknown>).setCookie })

  test('uses lax access cookies and strict refresh cookies', () => {
    const setCookie = jest.fn()
    ;(globalThis as Record<string, unknown>).setCookie = setCookie

    setAuthCookies({} as Parameters<typeof setAuthCookies>[0], { accessToken: 'a', refreshToken: 'r' })

    expect(setCookie).toHaveBeenNthCalledWith(1, {}, 'koda_token', 'a', expect.objectContaining({ sameSite: 'lax' }))
    expect(setCookie).toHaveBeenNthCalledWith(2, {}, 'koda_refresh', 'r', expect.objectContaining({ sameSite: 'strict' }))
  })
})
