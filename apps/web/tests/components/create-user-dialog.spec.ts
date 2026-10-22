/**
 * Permissions P1 US-011 (AC-9, AC-11): the create-user dialog lost its role field — a new account is
 * created role-less and its roles are bound afterwards. The real `useAdminUsers` runs over a fake
 * `$api`, so the assertion is on the HTTP body the API receives.
 */
import { describe, test, expect, jest } from '@jest/globals'
import { defineComponent, h } from 'vue'
import { useField } from 'vee-validate'
import { mountSfc, webFile } from '../helpers/mount-sfc'
import { uiStubs, enI18n } from '../helpers/fleet-harness'
import { byId, call, settle } from '../helpers/roles-dom'
import { ApiError, extractApiError } from '../../composables/useApi'
import { useAdminUsers } from '../../composables/useAdminUsers'

const dialogPath = webFile('components', 'CreateUserDialog.vue')

/** FormField hands its slot the real vee-validate binding, so `componentField` reaches the Input. */
const FormField = defineComponent({
  props: { name: { type: String, required: true } },
  setup(props, { slots }) {
    const { value, handleChange, handleBlur } = useField<string>(() => props.name)
    return () => slots.default?.({ componentField: {
      modelValue: value.value,
      'onUpdate:modelValue': handleChange,
      onBlur: handleBlur,
    } })
  },
})

const Input = defineComponent({
  props: { modelValue: String },
  emits: ['update:modelValue'],
  setup(props, { attrs, emit }) {
    return () => h('input', {
      ...attrs,
      // The value is mirrored onto the element so a test can read what the form still holds.
      value: props.modelValue,
      onInput: (event: Event) => emit('update:modelValue', (event.target as HTMLInputElement).value),
    })
  },
})

interface FakeApi {
  get: jest.Mock
  post: jest.Mock
  patch: jest.Mock
  delete: jest.Mock
}

function fakeApi(post: jest.Mock): FakeApi {
  return { get: jest.fn(async () => ({ records: [] })), post, patch: jest.fn(), delete: jest.fn() }
}

/** The shadcn stand-ins, minus the select stub: FleetNativeSelect is registered for real below. */
const stubs: Record<string, unknown> = { ...uiStubs }
delete stubs.FleetNativeSelect

interface Mount {
  app: ReturnType<typeof mountSfc>
  api: FakeApi
  toast: { success: jest.Mock; error: jest.Mock }
}

function mountDialog(api: FakeApi): Mount {
  const toast = { success: jest.fn(), error: jest.fn() }
  ;(globalThis as Record<string, unknown>).useApi = () => ({ $api: api })
  const app = mountSfc(dialogPath, {
    props: { open: true },
    globals: { useI18n: () => enI18n(), useAppToast: () => toast, useAdminUsers },
    components: { ...stubs, FormField, Input },
    // Registered for real so "no role field" means the select is gone, not that it stayed unresolved.
    fleetComponents: ['FleetNativeSelect'],
  })
  return { app, api, toast }
}

async function submitValid(app: ReturnType<typeof mountSfc>): Promise<void> {
  const form = byId(app, 'create-user-form')
  const inputs = app.find('input', form)
  expect(inputs).toHaveLength(3)
  call(inputs[0], 'onInput', { target: { value: 'ada@example.com' } })
  call(inputs[1], 'onInput', { target: { value: 'Ada Lovelace' } })
  call(inputs[2], 'onInput', { target: { value: 'StrongPass1!' } })
  await settle()
  await (form.props.onSubmit as (event: Event) => Promise<void>)({ preventDefault: () => undefined } as unknown as Event)
  await settle()
}

describe('AC-9: the create-user dialog has no role field and posts a role-less body', () => {
  test('renders no role control and posts { email, name, password } to /admin/users', async () => {
    const post = jest.fn(async () => ({ id: 'u9', email: 'ada@example.com', name: 'Ada Lovelace', role: 'MEMBER', disabled: false, createdAt: '2026-10-01T00:00:00Z' }))
    const { app, toast } = mountDialog(fakeApi(post))

    expect(app.find('select')).toHaveLength(0)
    expect(app.text()).not.toContain('admin.users.form.role')

    await submitValid(app)

    expect(post).toHaveBeenCalledTimes(1)
    expect(post).toHaveBeenCalledWith('/admin/users', {
      email: 'ada@example.com', name: 'Ada Lovelace', password: 'StrongPass1!',
    })
    expect(Object.keys(post.mock.calls[0][1] as Record<string, unknown>)).not.toContain('role')
    expect(toast.error).not.toHaveBeenCalled()
    app.unmount()
  })
})

describe('AC-11: a rejected POST /admin/users keeps the dialog open', () => {
  test('toasts the API error, closes nothing and emits no created', async () => {
    const err = new ApiError(409, 'A user with that email already exists')
    const post = jest.fn(async () => { throw err })
    const { app, toast } = mountDialog(fakeApi(post))

    await submitValid(app)

    expect(post).toHaveBeenCalledTimes(1)
    expect(toast.error).toHaveBeenCalledWith(extractApiError(err))
    expect(app.emitted('created')).toHaveLength(0)
    expect(app.emitted('update:open')).toHaveLength(0)
    // Still open with what was typed: the dialog was not reset.
    expect(app.find('input', byId(app, 'create-user-form'))[0].props.value).toBe('ada@example.com')
    app.unmount()
  })
})
