import { jest, test, expect } from '@jest/globals'

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
