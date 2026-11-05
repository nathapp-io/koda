/**
 * US-012: the GLOBAL provider keys admin page. Every write goes through
 * `useProviderCredentials`; the page owns the permission gates, the confirmation before DELETE and the
 * approval-pending notice.
 */
import { describe, test, expect, afterEach, jest } from '@jest/globals'
import * as Vue from 'vue'
import { ref, computed, watch, nextTick, h } from 'vue'
import { useField } from 'vee-validate'
import { mountSfc, webFile, type FakeNode } from '../helpers/mount-sfc'
import { uiStubs, enI18n, toastRecorder, type ToastRecorder } from '../helpers/fleet-harness'
import * as apiModule from '../../composables/useApi'
import { ApiError } from '../../composables/useApi'

const page = webFile('pages', 'admin', 'fleet', 'provider-keys.vue')
const t = enI18n().t

const row = (over: Record<string, unknown> = {}) => ({
  id: 'c1', scope: 'GLOBAL', projectId: null, repoId: null, providerId: 'openrouter', name: 'Team key',
  last4: 'abcd', fingerprint: '9f2c1a4b7d3e', disabled: false, createdBy: 'u1', updatedAt: '2026-10-01T00:00:00.000Z', ...over,
})
const pageOf = (records: unknown[], over: Record<string, unknown> = {}) =>
  ({ records, total: records.length, current: 1, size: 100, hasNext: false, hasPrev: false, ...over })
const approval = { id: 'ap1', permissionKey: 'fleet.credential.create', status: 'pending' }

/** A FormField that registers the real vee-validate field, so a test can type and see the error. */
const fieldStub = {
  props: ['name'],
  setup(props: { name: string }, { slots }: { slots: Record<string, ((arg: unknown) => unknown) | undefined> }) {
    const field = useField(props.name)
    return () => h('div', [
      slots.default?.({ componentField: { name: props.name, modelValue: field.value.value, 'onUpdate:modelValue': field.handleChange, onBlur: field.handleBlur } }) as never,
      field.errorMessage.value ? h('span', { 'data-field-error': props.name }, field.errorMessage.value) : null,
    ])
  },
}

interface Api {
  get: jest.Mock
  post: jest.Mock
  patch: jest.Mock
  delete: jest.Mock
}

interface Mounted {
  app: ReturnType<typeof mountSfc>
  api: Api
  toasts: ToastRecorder
  settle: () => Promise<void>
  byId: (id: string) => FakeNode[]
  text: () => string
  button: (id: string) => Record<string, unknown>
  unmount: () => void
}

function mountPage(over: {
  records?: unknown[]
  permissions?: string[]
  failLoad?: unknown
  get?: jest.Mock
  post?: (body: unknown) => Promise<unknown>
  patch?: (path: string, body: unknown) => Promise<unknown>
  deleteResult?: unknown
  confirm?: boolean
} = {}): Mounted {
  const api: Api = {
    get: over.get ?? jest.fn(async () => {
      if (over.failLoad) throw over.failLoad
      return pageOf(over.records ?? [row()])
    }),
    post: jest.fn(async (_path: string, body: unknown) => (over.post ? over.post(body) : row({ id: 'c2' }))),
    patch: jest.fn(async (path: string, body: unknown) => (over.patch ? over.patch(path, body) : row())),
    delete: jest.fn(async () => over.deleteResult ?? { deleted: true }),
  }
  const toasts = toastRecorder()
  const allowed = new Set(over.permissions ?? ['fleet.credential.read', 'fleet.credential.create', 'fleet.credential.update', 'fleet.credential.delete'])
  ;(globalThis as Record<string, unknown>).window = { confirm: () => over.confirm ?? true }
  ;(globalThis as Record<string, unknown>).useApi = () => ({ $api: api })

  const app = mountSfc(page, {
    components: { ...uiStubs, FormField: fieldStub },
    alias: { '~/composables/useApi': apiModule },
    globals: {
      ref, computed, watch, nextTick,
      onMounted: Vue.onMounted,
      useI18n: () => enI18n(),
      useAppToast: () => toasts,
      useApi: () => ({ $api: api }),
      useGlobalPermissions: () => ({ permissions: computed(() => ({ has: (key: string) => allowed.has(key) })) }),
    },
  })
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 6; i += 1) {
      await new Promise((resolve) => { setImmediate(resolve) })
      await Vue.nextTick()
    }
  }
  const byId = (id: string) => app.find(`[data-testid="${id}"]`)
  return {
    app,
    api,
    toasts,
    settle,
    byId,
    text: () => app.text(),
    button: (id: string) => {
      const found = byId(id)
      if (found.length !== 1) throw new Error(`expected one "${id}", found ${found.length} in: ${app.text()}`)
      return found[0].props
    },
    unmount: app.unmount,
  }
}

/** Types into an `<Input>` stub, which forwards `modelValue` / `onUpdate:modelValue` as props. */
function type(p: Mounted, testId: string, value: string): void {
  const found = p.byId(testId)
  if (found.length !== 1) throw new Error(`expected one "${testId}", found ${found.length} in: ${p.app.text()}`)
  ;(found[0].props['onUpdate:modelValue'] as (value: string) => void)(value)
}

async function submitAddForm(p: Mounted): Promise<void> {
  const form = p.app.one('form')
  if (!form) throw new Error(`no add form in: ${p.app.text()}`)
  await (form.props.onSubmit as (event: { preventDefault: () => void }) => Promise<void>)({ preventDefault: () => undefined })
  await p.settle()
}

const click = async (p: Mounted, id: string): Promise<void> => {
  await (p.button(id).onClick as () => void | Promise<void>)()
  await p.settle()
}

/**
 * Fires a control without awaiting its promise: a write whose response is deferred must be observed
 * while it is still in flight.
 */
const fire = async (p: Mounted, id: string): Promise<void> => {
  void (p.button(id).onClick as () => void | Promise<void>)()
  await Promise.resolve()
  await p.settle()
}

describe('admin provider keys page (US-012)', () => {
  afterEach(() => {
    delete (globalThis as Record<string, unknown>).window
    delete (globalThis as Record<string, unknown>).useApi
  })

  test('AC-1: lists rows from GET /fleet/provider-credentials with providerId, name, last4, fingerprint and disabled state', async () => {
    const p = mountPage({ records: [row(), row({ id: 'c2', providerId: 'anthropic', name: 'Billing A', last4: 'wxyz', fingerprint: 'aaaabbbbcccc', disabled: true })] })
    await p.settle()

    expect(p.api.get).toHaveBeenCalledWith('/fleet/provider-credentials', { query: { size: '100' } })
    const first = p.app.textOf(p.byId('provider-key-c1')[0])
    expect(first).toContain('openrouter')
    expect(first).toContain('Team key')
    expect(first).toContain('abcd')
    expect(first).toContain('9f2c1a4b7d3e')
    expect(p.byId('provider-key-c1')[0].props['data-disabled']).toBe('false')
    expect(p.byId('provider-key-c2')[0].props['data-disabled']).toBe('true')
    expect(p.app.textOf(p.byId('provider-key-state-c2')[0])).toBe(t('fleet.providerKeys.state.disabled'))
    p.unmount()
  })

  test('AC-2: submitting the add form POSTs { providerId, name, key }', async () => {
    const p = mountPage()
    await p.settle()

    type(p, 'provider-key-add-provider', 'anthropic')
    type(p, 'provider-key-add-name', 'Billing A')
    type(p, 'provider-key-add-key', 'sk-live-0123456789abcdef')
    await p.settle()
    await submitAddForm(p)

    expect(p.api.post).toHaveBeenCalledWith('/fleet/provider-credentials', {
      providerId: 'anthropic', name: 'Billing A', key: 'sk-live-0123456789abcdef',
    })
    expect(p.byId('provider-key-c2')).toHaveLength(1)
    p.unmount()
  })

  test('AC-3: after a successful add the key input is empty', async () => {
    const p = mountPage()
    await p.settle()

    type(p, 'provider-key-add-name', 'Billing A')
    type(p, 'provider-key-add-provider', 'anthropic')
    type(p, 'provider-key-add-key', 'sk-live-0123456789abcdef')
    await p.settle()
    await submitAddForm(p)

    expect((p.byId('provider-key-add-key')[0].props.modelValue as string | undefined) ?? '').toBe('')
    p.unmount()
  })

  test('AC-4: an uppercase providerId is refused with the translated message and sends no request', async () => {
    const p = mountPage()
    await p.settle()

    type(p, 'provider-key-add-provider', 'OpenRouter')
    type(p, 'provider-key-add-name', 'Team key')
    type(p, 'provider-key-add-key', 'sk-live-0123456789abcdef')
    await p.settle()
    await submitAddForm(p)

    expect(p.text()).toContain(t('fleet.providerKeys.validation.providerId'))
    expect(p.api.post).not.toHaveBeenCalled()
    p.unmount()
  })

  test('a key with whitespace is refused with its translated message and sends no request', async () => {
    const p = mountPage()
    await p.settle()

    type(p, 'provider-key-add-provider', 'anthropic')
    type(p, 'provider-key-add-name', 'Team key')
    type(p, 'provider-key-add-key', 'sk live 0123456789abcdef')
    await p.settle()
    await submitAddForm(p)

    expect(p.text()).toContain(t('fleet.providerKeys.validation.keyWhitespace'))
    expect(p.api.post).not.toHaveBeenCalled()
    p.unmount()
  })

  test('AC-5: rotate PATCHes the credential with { key } only', async () => {
    const p = mountPage()
    await p.settle()

    type(p, 'provider-key-rotate-c1', 'sk-live-fedcba9876543210')
    await p.settle()
    await click(p, 'provider-key-rotate-button-c1')

    expect(p.api.patch).toHaveBeenCalledWith('/fleet/provider-credentials/c1', { key: 'sk-live-fedcba9876543210' })
    p.unmount()
  })

  test('AC-6: disable PATCHes { disabled: true }', async () => {
    const p = mountPage({ patch: async () => row({ disabled: true }) })
    await p.settle()

    await click(p, 'provider-key-toggle-c1')

    expect(p.api.patch).toHaveBeenCalledWith('/fleet/provider-credentials/c1', { disabled: true })
    expect(p.byId('provider-key-c1')[0].props['data-disabled']).toBe('true')
    p.unmount()
  })

  test('AC-7: enable PATCHes { disabled: false }', async () => {
    const p = mountPage({ records: [row({ disabled: true })], patch: async () => row({ disabled: false }) })
    await p.settle()

    await click(p, 'provider-key-toggle-c1')

    expect(p.api.patch).toHaveBeenCalledWith('/fleet/provider-credentials/c1', { disabled: false })
    expect(p.byId('provider-key-c1')[0].props['data-disabled']).toBe('false')
    p.unmount()
  })

  test('AC-8: DELETE runs only after the confirmation is accepted', async () => {
    const refused = mountPage({ confirm: false })
    await refused.settle()
    await click(refused, 'provider-key-delete-c1')
    expect(refused.api.delete).not.toHaveBeenCalled()
    expect(refused.byId('provider-key-c1')).toHaveLength(1)
    refused.unmount()

    const accepted = mountPage({ confirm: true })
    await accepted.settle()
    await click(accepted, 'provider-key-delete-c1')
    expect(accepted.api.delete).toHaveBeenCalledWith('/fleet/provider-credentials/c1')
    expect(accepted.byId('provider-key-c1')).toHaveLength(0)
    accepted.unmount()
  })

  test('AC-9: a write answered with an approval request shows the pending notice and adds no row', async () => {
    const p = mountPage({ post: async () => approval })
    await p.settle()

    type(p, 'provider-key-add-provider', 'anthropic')
    type(p, 'provider-key-add-name', 'Billing A')
    type(p, 'provider-key-add-key', 'sk-live-0123456789abcdef')
    await p.settle()
    await submitAddForm(p)

    expect(p.app.textOf(p.byId('provider-keys-notice')[0])).toBe(t('fleet.providerKeys.pending'))
    expect(p.byId('provider-key-c2')).toHaveLength(0)
    expect(p.toasts.successes).toEqual([])
    p.unmount()
  })

  test('AC-10: the add control is hidden without fleet.credential.create', async () => {
    const p = mountPage({ permissions: ['fleet.credential.read', 'fleet.credential.update', 'fleet.credential.delete'] })
    await p.settle()

    expect(p.byId('provider-key-add-form')).toHaveLength(0)
    expect(p.byId('provider-key-add-submit')).toHaveLength(0)
    // The read-only list still renders.
    expect(p.byId('provider-key-c1')).toHaveLength(1)
    p.unmount()
  })

  test('the update and delete controls follow their own keys', async () => {
    const p = mountPage({ permissions: ['fleet.credential.read', 'fleet.credential.create'] })
    await p.settle()

    expect(p.byId('provider-key-add-form')).toHaveLength(1)
    expect(p.byId('provider-key-rotate-button-c1')).toHaveLength(0)
    expect(p.byId('provider-key-toggle-c1')).toHaveLength(0)
    expect(p.byId('provider-key-delete-c1')).toHaveLength(0)
    p.unmount()
  })

  test('AC-11: a refused request is shown through the app toast with the API message', async () => {
    const p = mountPage({ post: async () => { throw new ApiError(40009, 'A key for this provider already exists') } })
    await p.settle()

    type(p, 'provider-key-add-provider', 'anthropic')
    type(p, 'provider-key-add-name', 'Billing A')
    type(p, 'provider-key-add-key', 'sk-live-0123456789abcdef')
    await p.settle()
    await submitAddForm(p)

    expect(p.toasts.errors).toEqual(['A key for this provider already exists'])
    p.unmount()
  })

  test('a 403 on load shows the admin-only note instead of the list', async () => {
    const p = mountPage({ failLoad: new ApiError(40003, 'forbidden') })
    await p.settle()

    expect(p.app.textOf(p.byId('provider-keys-forbidden')[0])).toBe(t('fleet.common.adminOnly'))
    expect(p.byId('provider-key-c1')).toHaveLength(0)
    p.unmount()
  })

  test('a failed load toasts the API message', async () => {
    const p = mountPage({ failLoad: new Error('API down') })
    await p.settle()

    expect(p.toasts.errors).toEqual(['API down'])
    p.unmount()
  })

  test('a name longer than 64 characters and a key shorter than 16 are refused with their own messages', async () => {
    const p = mountPage()
    await p.settle()

    type(p, 'provider-key-add-provider', 'anthropic')
    type(p, 'provider-key-add-name', 'n'.repeat(65))
    type(p, 'provider-key-add-key', 'sk-live-0123456789abcdef')
    await p.settle()
    await submitAddForm(p)
    expect(p.text()).toContain(t('fleet.providerKeys.validation.nameLength'))

    type(p, 'provider-key-add-name', 'Billing A')
    type(p, 'provider-key-add-key', 'short')
    await p.settle()
    await submitAddForm(p)
    expect(p.text()).toContain(t('fleet.providerKeys.validation.keyLength'))
    expect(p.api.post).not.toHaveBeenCalled()
    p.unmount()
  })

  test('a rotate answered with an approval request shows the notice, keeps the row and no success toast', async () => {
    const p = mountPage({ patch: async () => approval })
    await p.settle()

    type(p, 'provider-key-rotate-c1', 'sk-live-fedcba9876543210')
    await p.settle()
    await click(p, 'provider-key-rotate-button-c1')

    expect(p.app.textOf(p.byId('provider-keys-notice')[0])).toBe(t('fleet.providerKeys.pending'))
    expect(p.toasts.successes).toEqual([])
    expect(p.byId('provider-key-c1')).toHaveLength(1)
    p.unmount()
  })

  test('a delete answered with an approval request keeps the row and shows the notice', async () => {
    const p = mountPage({ deleteResult: approval })
    await p.settle()

    await click(p, 'provider-key-delete-c1')

    expect(p.api.delete).toHaveBeenCalledWith('/fleet/provider-credentials/c1')
    expect(p.app.textOf(p.byId('provider-keys-notice')[0])).toBe(t('fleet.providerKeys.pending'))
    expect(p.byId('provider-key-c1')).toHaveLength(1)
    p.unmount()
  })

  test('a rotate with an invalid key is refused before any request', async () => {
    const p = mountPage()
    await p.settle()

    type(p, 'provider-key-rotate-c1', 'has spaces in it 0123456789')
    await p.settle()
    await click(p, 'provider-key-rotate-button-c1')

    expect(p.api.patch).not.toHaveBeenCalled()
    expect(p.app.textOf(p.byId('provider-key-rotate-error-c1')[0])).toBe(t('fleet.providerKeys.validation.keyWhitespace'))
    p.unmount()
  })

  test('F1: a credential on the second page is reachable and manageable', async () => {
    const pageTwo = row({ id: 'c101', providerId: 'page-two', name: 'Second hundred', fingerprint: 'ffffffffffff' })
    const get = jest.fn(async (_path: string, options: { query: Record<string, string> }) =>
      (options.query.current === '2'
        ? pageOf([pageTwo], { current: 2, hasNext: false, hasPrev: true, total: 101 })
        : pageOf([row()], { current: 1, hasNext: true, hasPrev: false, total: 101 })))
    const p = mountPage({ get })
    await p.settle()

    expect(get).toHaveBeenNthCalledWith(1, '/fleet/provider-credentials', { query: { size: '100' } })
    expect(p.byId('provider-key-c101')).toHaveLength(0)
    expect(p.button('provider-keys-prev').disabled).toBe(true)

    await click(p, 'provider-keys-next')

    expect(get).toHaveBeenNthCalledWith(2, '/fleet/provider-credentials', { query: { size: '100', current: '2' } })
    expect(p.byId('provider-key-c101')).toHaveLength(1)
    expect(p.app.textOf(p.byId('provider-key-c101')[0])).toContain('ffffffffffff')
    expect(p.button('provider-keys-next').disabled).toBe(true)

    // The row on page two is a normal row: it can be rotated.
    type(p, 'provider-key-rotate-c101', 'sk-live-fedcba9876543210')
    await p.settle()
    await click(p, 'provider-key-rotate-button-c101')
    expect(p.api.patch).toHaveBeenCalledWith('/fleet/provider-credentials/c101', { key: 'sk-live-fedcba9876543210' })

    // And the way back loads the first page again.
    await click(p, 'provider-keys-prev')
    expect(get).toHaveBeenLastCalledWith('/fleet/provider-credentials', { query: { size: '100' } })
    expect(p.byId('provider-key-c1')).toHaveLength(1)
    p.unmount()
  })

  test('F2: two rows writing at once each stay disabled until their own response lands', async () => {
    const releases: Record<string, (value: unknown) => void> = {}
    const p = mountPage({
      records: [row(), row({ id: 'c2', providerId: 'anthropic', name: 'Billing A' })],
      patch: (path: string) => new Promise((resolve) => { releases[path.split('/').pop() ?? ''] = resolve }),
    })
    await p.settle()

    type(p, 'provider-key-rotate-c1', 'sk-live-fedcba9876543210')
    await p.settle()
    await fire(p, 'provider-key-rotate-button-c1')
    await fire(p, 'provider-key-toggle-c2')

    // Row c1 keeps its busy marker while c2's write starts: the second write must not re-enable it.
    expect(p.button('provider-key-rotate-button-c1').disabled).toBe(true)
    expect(p.button('provider-key-toggle-c2').disabled).toBe(true)

    releases.c1?.(row({ fingerprint: 'ffffffffffff', last4: 'wxyz' }))
    await p.settle()

    expect(p.app.textOf(p.byId('provider-key-c1')[0])).toContain('ffffffffffff')
    expect(p.button('provider-key-rotate-button-c1').disabled).toBe(false)
    expect(p.button('provider-key-toggle-c2').disabled).toBe(true)

    releases.c2?.(row({ id: 'c2', providerId: 'anthropic', name: 'Billing A', disabled: true }))
    await p.settle()

    expect(p.byId('provider-key-c2')[0].props['data-disabled']).toBe('true')
    expect(p.button('provider-key-toggle-c2').disabled).toBe(false)
    p.unmount()
  })

  test('F2: a second write on the same row is refused while the first is pending (button and Enter)', async () => {
    let release: (value: unknown) => void = () => undefined
    const patch = jest.fn(() => new Promise<unknown>((resolve) => { release = resolve }))
    const p = mountPage({ patch })
    await p.settle()

    type(p, 'provider-key-rotate-c1', 'sk-live-fedcba9876543210')
    await p.settle()
    await fire(p, 'provider-key-rotate-button-c1')

    // The field is closed while its row is busy, so Enter cannot start a second write either.
    expect(p.byId('provider-key-rotate-c1')[0].props.disabled).toBe(true)
    await (p.byId('provider-key-rotate-c1')[0].props.onKeyup as (event: { key: string }) => void)({ key: 'Enter' })
    await (p.button('provider-key-rotate-button-c1').onClick as () => void)()
    await (p.button('provider-key-toggle-c1').onClick as () => void)()
    await p.settle()

    expect(patch).toHaveBeenCalledTimes(1)

    release(row())
    await p.settle()

    expect(p.byId('provider-key-rotate-c1')[0].props.disabled).toBe(false)
    expect(patch).toHaveBeenCalledTimes(1)
    p.unmount()
  })
})
