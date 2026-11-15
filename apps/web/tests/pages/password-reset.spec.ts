import { beforeEach, expect, jest, test } from '@jest/globals'
import { nextTick } from 'vue'
import { mountSfc } from '../helpers/mount-sfc'
import { ApiError } from '~/composables/useApi'

const requestReset = jest.fn<() => Promise<void>>()
const confirmReset = jest.fn<() => Promise<void>>()
const navigateTo = jest.fn()
const error = jest.fn()
function page(name: string, query: Record<string, string> = {}) {
  return mountSfc(`pages/${name}.vue`, {
    globals: { useI18n: () => ({ t: (k: string) => k }), useHead: () => undefined, useRoute: () => ({ params: { token: 'tok' }, query }), navigateTo, useAppToast: () => ({ error }), useAuth: () => ({ login: jest.fn() }), useRegistrationStatus: () => ({ open: false, load: jest.fn() }), onMounted: () => undefined },
    alias: { '~/composables/usePasswordActions': { usePasswordActions: () => ({ requestReset, confirmReset }) } },
    components: { Button: { template: '<button><slot /></button>' }, NuxtLink: { props: ['to'], template: '<a :href="to"><slot /></a>' }, FormField: { template: '<div><slot :componentField="{}" /></div>' }, FormItem: { template: '<div><slot /></div>' }, FormLabel: { template: '<label><slot /></label>' }, FormControl: { template: '<div><slot /></div>' }, FormMessage: { template: '<div />' }, Input: { template: '<input />' } },
  })
}
async function submit(m: ReturnType<typeof page>, fields: Record<string, string>) {
  for (const [id, value] of Object.entries(fields)) {
    const input = m.find('input').find(n => n.props.id === id)
    if (!input) throw new Error(`Missing ${id}`)
    ;(input.props.onInput as (e: unknown) => void)({ target: { value } })
  }
  await nextTick()
  const form = m.one('form')
  if (!form) throw new Error('Missing form')
  ;(form.props.onSubmit as (e: unknown) => void)({ preventDefault() {}, stopPropagation() {} })
  for (let i = 0; i < 10; i++) { await new Promise(resolve => setTimeout(resolve, 0)); await nextTick() }
}
beforeEach(() => { requestReset.mockReset().mockResolvedValue(); confirmReset.mockReset().mockResolvedValue(); navigateTo.mockReset(); error.mockReset() })
test.each(['resolved', 'rejected'])('AC-3/4 forgot feedback after %s request', async outcome => {
  if (outcome === 'rejected') requestReset.mockRejectedValue(new Error('offline'))
  const m = page('forgot-password'); await submit(m, { email: 'a@b.com' })
  expect(requestReset).toHaveBeenCalledWith('a@b.com'); expect(m.text()).toContain('auth.forgot.checkEmail'); m.unmount()
})
test('AC-5 token and success navigation', async () => {
  const m = page('reset-password/[token]'); await submit(m, { newPassword: 'NewPass1!', confirmNewPassword: 'NewPass1!' })
  expect(confirmReset).toHaveBeenCalledWith('tok', 'NewPass1!'); expect(navigateTo).toHaveBeenCalledWith('/login?reset=1'); m.unmount()
})
test.each([{ status: 400 }, new ApiError(-2, 'invalid'), new ApiError(400, 'invalid')])('AC-6 invalid link recovery %p', async failure => {
  confirmReset.mockRejectedValue(failure); const m = page('reset-password/[token]'); await submit(m, { newPassword: 'NewPass1!', confirmNewPassword: 'NewPass1!' })
  expect(m.text()).toContain('auth.reset.invalid'); expect(m.find('a').some(n => n.props.href === '/forgot-password')).toBe(true); m.unmount()
})
/**
 * B3: the API's field-validation envelope (`{ ret: -2, errors: { newPassword: [...] } }`, the
 * `@nathapp/nestjs-common` default formatter) is not a dead link — the token is still usable, so the form
 * stays and the message shows on the field. The token-refusal envelope carries no `errors` at all.
 */
test.each([
  ['ApiError', new ApiError(-2, 'Validation failed', { newPassword: ['Password must contain an uppercase letter'] })],
  ['raw fetch error', { status: 400, data: { ret: -2, message: 'Validation failed', errors: { newPassword: ['Password must contain an uppercase letter'] } } }],
])('B3: a %s field validation failure keeps the form and shows the newPassword message', async (_shape, failure) => {
  confirmReset.mockRejectedValue(failure)
  const m = page('reset-password/[token]'); await submit(m, { newPassword: 'lowercase1!', confirmNewPassword: 'lowercase1!' })
  expect(confirmReset).toHaveBeenCalledWith('tok', 'lowercase1!')
  expect(m.text()).toContain('Password must contain an uppercase letter')
  expect(m.text()).not.toContain('auth.reset.invalid')
  expect(m.one('form')).toBeTruthy()
  expect(navigateTo).not.toHaveBeenCalled()
  m.unmount()
})
test('AC-7 mismatch blocks submission', async () => {
  const m = page('reset-password/[token]'); await submit(m, { newPassword: 'NewPass1!', confirmNewPassword: 'different' })
  expect(confirmReset).not.toHaveBeenCalled(); expect(m.text()).toContain('auth.account.mismatch'); m.unmount()
})
test('AC-8 login has forgot link', () => { const m = page('login'); expect(m.find('a').some(n => n.props.href === '/forgot-password')).toBe(true); m.unmount() })
test('AC-9 login notice only after reset', () => { const a = page('login', { reset: '1' }); expect(a.text()).toContain('auth.reset.loginNotice'); a.unmount(); const b = page('login'); expect(b.text()).not.toContain('auth.reset.loginNotice'); b.unmount() })
