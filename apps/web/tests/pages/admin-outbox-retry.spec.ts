import { describe, test, expect, jest } from '@jest/globals'
import { ApiError } from '../../composables/useApi'
import * as apiModule from '../../composables/useApi'
import { mountSfc, webFile, type FakeNode } from '../helpers/mount-sfc'
import { enI18n, toastRecorder, uiStubs } from '../helpers/fleet-harness'
import { globalPermissionsStub } from '../helpers/permission-nav'

const page = webFile('pages', 'admin', 'outbox.vue')
const row = (status = 'dead') => ({
  id: 'row-1', projectId: 'p1', type: 'ticket_event', eventId: 'evt-9', payload: {}, headers: null,
  status, attempts: 1, nextAttemptAt: null, leaseUntil: null, owner: null, lastError: null,
  publishedAt: null, createdAt: '2026-01-01', updatedAt: '2026-01-01',
})
const pendingRequest = { id: 'approval-1', permissionKey: 'outbox.retry' }
const tick = async () => { for (let i = 0; i < 4; i++) { await new Promise(resolve => setImmediate(resolve)); await Promise.resolve() } }

function mountOutbox(get: jest.Mock, post: jest.Mock, keys: string[] = ['outbox.retry']) {
  const toast = toastRecorder()
  const app = mountSfc(page, {
    components: uiStubs,
    alias: { '~/composables/useApi': apiModule },
    globals: {
      useI18n: () => enI18n(), useAppToast: () => toast,
      useApi: () => ({ $api: { get, post } }),
      useGlobalPermissions: () => globalPermissionsStub(keys),
    },
  })
  return { app, toast }
}
function retryButtons(app: ReturnType<typeof mountSfc>): FakeNode[] {
  return app.find('button').filter((button: FakeNode) => app.textOf(button) === enI18n().t('outbox.retry.action'))
}
async function clickRetry(app: ReturnType<typeof mountSfc>) {
  const button = retryButtons(app)[0]
  if (!button) throw new Error('Retry button not found')
  await (button.props.onClick as () => Promise<void>)()
  await tick()
}

describe('/admin/outbox retry', () => {
  test('AC-4: dead rows render retry action with global permission', async () => {
    const { app } = mountOutbox(jest.fn(async () => ({ items: [row()], total: 1 })), jest.fn(async () => undefined))
    await tick()
    expect(retryButtons(app)).toHaveLength(1)
    app.unmount()
  })

  test('AC-5: pending rows render retry action with global permission', async () => {
    const get = jest.fn(async () => ({ items: [row('pending')], total: 1 }))
    const { app } = mountOutbox(get, jest.fn(async () => undefined))
    await tick()
    const select = app.one('select')
    ;(select?.props.onChange as (event: { target: { value: string } }) => void)({ target: { value: 'pending' } })
    await tick()
    expect(get).toHaveBeenLastCalledWith('/admin/outbox', { query: { status: 'pending' } })
    expect(retryButtons(app)).toHaveLength(1)
    app.unmount()
  })

  test('AC-6: no retry permission hides the action', async () => {
    const { app } = mountOutbox(jest.fn(async () => ({ items: [row()], total: 1 })), jest.fn(async () => undefined), [])
    await tick()
    expect(retryButtons(app)).toHaveLength(0)
    app.unmount()
  })

  test.each(['processing', 'published'])('AC-7: %s rows do not render retry action', async (status) => {
    const { app } = mountOutbox(jest.fn(async () => ({ items: [row(status)], total: 1 })), jest.fn(async () => undefined))
    await tick()
    expect(retryButtons(app)).toHaveLength(0)
    app.unmount()
  })

  test('AC-8: clicking row action posts row id, not eventId', async () => {
    const post = jest.fn(async () => undefined)
    const { app } = mountOutbox(jest.fn(async () => ({ items: [row()], total: 1 })), post)
    await tick()
    await clickRetry(app)
    expect(post).toHaveBeenCalledWith('/admin/outbox/row-1/retry')
    app.unmount()
  })

  test('AC-9 and AC-10: completed retry toasts success and reloads current dead filter', async () => {
    const get = jest.fn(async () => ({ items: [row()], total: 1 }))
    const { app, toast } = mountOutbox(get, jest.fn(async () => undefined))
    await tick()
    await clickRetry(app)
    expect(toast.successes).toContain(enI18n().t('outbox.retry.done'))
    expect(get).toHaveBeenCalledTimes(2)
    expect(get).toHaveBeenLastCalledWith('/admin/outbox', { query: { status: 'dead' } })
    app.unmount()
  })

  test('AC-11 and AC-12: pending retry toasts and does not reload', async () => {
    const get = jest.fn(async () => ({ items: [row()], total: 1 }))
    const { app, toast } = mountOutbox(get, jest.fn(async () => pendingRequest))
    await tick()
    await clickRetry(app)
    expect(toast.successes).toContain(enI18n().t('outbox.retry.pending'))
    expect(get).toHaveBeenCalledTimes(1)
    app.unmount()
  })

  test.each(['403 Forbidden', '404 Not found', '409 Outbox event is processing; only dead or pending events can be retried', 'network error'])(
    'AC-13 and AC-14: rejected retry %s reports error without reload', async (failure) => {
      const message = failure.slice(failure.indexOf(' ') + 1)
      const get = jest.fn(async () => ({ items: [row()], total: 1 }))
      const post = jest.fn(async () => { throw failure.startsWith('network') ? new Error(message) : new ApiError(Number(failure.slice(0, 3)), message) })
      const { app, toast } = mountOutbox(get, post)
      await tick()
      await clickRetry(app)
      expect(toast.errors).toContain(message)
      expect(get).toHaveBeenCalledTimes(1)
      app.unmount()
    },
  )

  test('AC-15: no permission still preserves read-only row rendering', async () => {
    const { app } = mountOutbox(jest.fn(async () => ({ items: [row()], total: 1 })), jest.fn(async () => undefined), [])
    await tick()
    expect(app.text()).toContain('ticket_event')
    app.unmount()
  })
})
