import { jest, test, expect } from '@jest/globals'
import { ApiError } from '~/composables/useApi'

test('AC-4 changePassword posts exactly the two passwords', async () => {
  const post = jest.fn(async () => undefined)
  ;(globalThis as Record<string, unknown>).useApi = () => ({ $api: { post } })
  const { usePasswordActions } = await import('../../composables/usePasswordActions')
  await usePasswordActions().changePassword({ currentPassword: 'a', newPassword: 'B' })
  expect(post).toHaveBeenCalledWith('/auth/password', { currentPassword: 'a', newPassword: 'B' })
})


test('AC-1 request reset posts email', async () => {
  const post = jest.fn(async () => undefined)
  ;(globalThis as Record<string, unknown>).useApi = () => ({ $api: { post } })
  const { usePasswordActions } = await import('../../composables/usePasswordActions')
  await usePasswordActions().requestReset('a@b.c')
  expect(post).toHaveBeenCalledWith('/auth/password-reset', { email: 'a@b.c' })
})
test('AC-2 confirm reset posts token and password', async () => {
  const post = jest.fn(async () => undefined)
  ;(globalThis as Record<string, unknown>).useApi = () => ({ $api: { post } })
  const { usePasswordActions } = await import('../../composables/usePasswordActions')
  await usePasswordActions().confirmReset('tok', 'NewPass1!')
  expect(post).toHaveBeenCalledWith('/auth/password-reset/confirm', { token: 'tok', newPassword: 'NewPass1!' })
})

/**
 * AC-8 support: the account page must map a failed change to the wrong-current-password field
 * error. useApi turns the API envelope into an ApiError carrying only `ret` (40003 for the auth
 * catalog's `auth.currentPasswordWrong`), and an error that never reached the envelope keeps its
 * HTTP status, so the predicate has to recognize both shapes and nothing else.
 */
test('AC-8 support the wrong-current-password predicate recognizes both error shapes', async () => {
  const { CURRENT_PASSWORD_WRONG_CODE, isCurrentPasswordWrong } = await import('../../composables/usePasswordActions')

  expect(CURRENT_PASSWORD_WRONG_CODE).toBe(40003)
  expect(isCurrentPasswordWrong(new ApiError(CURRENT_PASSWORD_WRONG_CODE, 'The current password is incorrect'))).toBe(true)
  expect(isCurrentPasswordWrong(Object.assign(new Error('HTTP 403'), { status: 403 }))).toBe(true)
  expect(isCurrentPasswordWrong({ response: { status: 403 } })).toBe(true)

  expect(isCurrentPasswordWrong(Object.assign(new Error('HTTP 500'), { status: 500 }))).toBe(false)
  expect(isCurrentPasswordWrong(new ApiError(40000, 'Unauthorized'))).toBe(false)
  expect(isCurrentPasswordWrong(undefined)).toBe(false)
  expect(isCurrentPasswordWrong(null)).toBe(false)
  expect(isCurrentPasswordWrong('403')).toBe(false)
})
