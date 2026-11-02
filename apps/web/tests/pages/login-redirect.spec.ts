import { afterEach, describe, expect, jest, test } from '@jest/globals'
import { mountSfc, webFile } from '../helpers/mount-sfc'

const file = webFile('pages', 'login.vue')

describe('login return-to redirect', () => {
  afterEach(() => jest.restoreAllMocks())

  test('navigates to the validated redirect after a successful login', async () => {
    const login = jest.fn(async () => undefined)
    const navigateTo = jest.fn()
    const success = jest.fn()
    const useForm = jest.fn(() => ({ handleSubmit: (fn: (values: { email: string; password: string }) => unknown) => () => fn({ email: 'a@b.com', password: 'password' }) }))
    const app = mountSfc(file, {
      globals: {
        useRoute: () => ({ query: { redirect: '/demo/fleet' } }),
        useRegistrationStatus: () => ({ open: false, load: jest.fn() }),
        useHead: jest.fn(),
        useAuth: () => ({ login }),
        useAppToast: () => ({ success, error: jest.fn() }),
        useI18n: () => ({ t: (key: string) => key }),
        navigateTo,
        onMounted: (fn: () => void) => fn(),
      },
      alias: {
        'vee-validate': { useForm },
        '@vee-validate/zod': { toTypedSchema: (schema: unknown) => schema },
      },
      components: {
        FormField: { template: '<div><slot :componentField="{}" /></div>' },
        FormItem: { template: '<div><slot /></div>' },
        FormLabel: { template: '<label><slot /></label>' },
        FormControl: { template: '<div><slot /></div>' },
        FormMessage: { template: '<div />' },
        Input: { template: '<input />' },
        Button: { template: '<button><slot /></button>' },
        NuxtLink: { template: '<a><slot /></a>' },
      },
    })

    const submit = app.one('form')?.props.onSubmit as ((event: { preventDefault: () => void }) => Promise<void>)
    await submit({ preventDefault: jest.fn() })

    expect(login).toHaveBeenCalledWith({ email: 'a@b.com', password: 'password' })
    expect(navigateTo).toHaveBeenCalledWith('/demo/fleet')
    app.unmount()
  })
})
