import { jest, test, expect } from '@jest/globals'

test('AC-4 changePassword posts exactly the two passwords', async () => {
  const post = jest.fn(async () => undefined)
  ;(globalThis as Record<string, unknown>).useApi = () => ({ $api: { post } })
  const { usePasswordActions } = await import('../../composables/usePasswordActions')
  await usePasswordActions().changePassword({ currentPassword: 'a', newPassword: 'B' })
  expect(post).toHaveBeenCalledWith('/auth/password', { currentPassword: 'a', newPassword: 'B' })
})
