import { jest, test, expect, beforeEach } from '@jest/globals'
import { nextTick } from 'vue'
import { mountSfc } from '../helpers/mount-sfc'
import { ApiError } from '~/composables/useApi'
import { isCurrentPasswordWrong } from '~/composables/usePasswordActions'

const changePassword = jest.fn<() => Promise<void>>()
const success = jest.fn()
const error = jest.fn()
const page = () => mountSfc('pages/settings/account.vue', {
  globals: { useI18n: () => ({ t: (key: string) => key }), useAppToast: () => ({ success, error }), useHead: () => undefined },
  components: { Button: { template: '<button><slot /></button>' } },
  // Only the transport is stubbed: the page keeps the real wrong-password predicate,
  // so AC-8/AC-9 exercise the mapping from ApiError/HTTP status to the field error.
  alias: { '~/composables/usePasswordActions': { usePasswordActions: () => ({ changePassword }), isCurrentPasswordWrong } },
})
async function fill(m: ReturnType<typeof page>, confirm = 'new-password') {
  for (const [id, value] of [['currentPassword', 'old-password'], ['newPassword', 'new-password'], ['confirmNewPassword', confirm]]) {
    const input = m.one(`#${id}`) ?? m.find('input').find(n => n.props.id === id)
    if (!input) throw new Error(`Missing input ${id}`)
    const onInput = input.props.onInput as (e: unknown) => void
    onInput({ target: { value } })
  }
  await nextTick()
}
async function submit(m: ReturnType<typeof page>) {
  const form = m.one('form')
  if (!form) throw new Error('Missing form')
  const onSubmit = form.props.onSubmit as (e: unknown) => void
  onSubmit({ preventDefault: () => undefined, stopPropagation: () => undefined })
  for (let i = 0; i < 10; i++) { await new Promise(resolve => setTimeout(resolve, 0)); await nextTick() }
}
beforeEach(() => { changePassword.mockReset(); changePassword.mockResolvedValue(); success.mockReset(); error.mockReset() })
test('AC-5 matching passwords submit only current and new', async () => {
  const m = page(); await fill(m); await submit(m)
  expect(changePassword).toHaveBeenCalledTimes(1)
  expect(changePassword).toHaveBeenCalledWith({ currentPassword: 'old-password', newPassword: 'new-password' })
  m.unmount()
})
test('AC-6 mismatch shows validation and prevents submission', async () => {
  const m = page(); await fill(m, 'different'); await submit(m)
  expect(changePassword).not.toHaveBeenCalled(); expect(m.text()).toContain('auth.account.mismatch'); m.unmount()
})
test('AC-7 success toasts and clears fields', async () => {
  const m = page(); await fill(m); await submit(m)
  expect(success).toHaveBeenCalledWith('auth.account.success')
  expect(m.find('input').map(n => n.props.value)).toEqual(['', '', '']); m.unmount()
})
test.each([{ status: 403 }, new ApiError(40003, 'wrong')])('AC-8 wrong password is shown on the current field %p', async (failure) => {
  changePassword.mockRejectedValue(failure)
  const m = page(); await fill(m); await submit(m)
  const field = m.find('input').find(n => n.props.id === 'currentPassword')?.parent
  if (!field) throw new Error('Missing current password field')
  expect(m.textOf(field)).toContain('auth.account.currentPasswordWrong'); expect(error).not.toHaveBeenCalled(); m.unmount()
})
test('validation errors are associated with their password input', async () => {
  const m = page(); await fill(m, 'different'); await submit(m)
  const input = m.find('input').find(n => n.props.id === 'confirmNewPassword')
  expect(input?.props['aria-invalid']).toBe('true')
  expect(input?.props['aria-describedby']).toBe('confirmNewPassword-error')
  expect(m.find('p').find(n => n.props.id === 'confirmNewPassword-error')).toBeDefined()
  m.unmount()
})
test('AC-9 HTTP 500 envelope is shown using extractApiError', async () => {
  const failure = Object.assign(new Error('HTTP 500'), {
    status: 500,
    data: { ret: 50000, message: 'server unavailable' },
  })
  changePassword.mockRejectedValue(failure)
  const m = page(); await fill(m); await submit(m)
  expect(changePassword).toHaveBeenCalledTimes(1)
  expect(error).toHaveBeenCalledWith('server unavailable')
  expect(m.text()).not.toContain('auth.account.currentPasswordWrong')
  m.unmount()
})
