import { describe, expect, test } from '@jest/globals'
import { safeRedirectPath } from '~/lib/safe-redirect'

describe('safeRedirectPath', () => {
  test('preserves same-origin deep links including query strings', () => {
    expect(safeRedirectPath('/demo/tickets/KODA-12?tab=activity')).toBe('/demo/tickets/KODA-12?tab=activity')
  })

  test.each([
    '//evil.example/x',
    `/\\u005cevil.example`,
    'https://evil.example/',
    undefined,
    ['/a'],
    '/login?redirect=/x',
    '/register',
    '/a\nb',
  ])('rejects unsafe redirect %p', (value) => {
    expect(safeRedirectPath(value)).toBe('/')
  })
})
