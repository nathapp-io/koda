import { ApiError } from '~/composables/useApi'
import { isNotFoundError } from '~/lib/not-found'

describe('isNotFoundError', () => {
  it('AC-1: recognizes the API not-found code', () => {
    expect(isNotFoundError(new ApiError(40004, 'gone'))).toBe(true)
  })

  it('AC-2: recognizes an API 404 code', () => {
    expect(isNotFoundError(new ApiError(404, 'gone'))).toBe(true)
  })

  it('AC-3: recognizes an HTTP 404 status', () => {
    expect(isNotFoundError({ status: 404 })).toBe(true)
  })

  it('AC-4: does not treat forbidden API errors as not-found', () => {
    expect(isNotFoundError(new ApiError(40003, 'forbidden'))).toBe(false)
  })
})
