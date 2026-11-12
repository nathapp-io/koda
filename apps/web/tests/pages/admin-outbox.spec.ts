import { describe, test, expect, jest } from '@jest/globals'
import { ApiError } from '../../composables/useApi'
import * as apiModule from '../../composables/useApi'
import { mountSfc, webFile } from '../helpers/mount-sfc'
import { enI18n, toastRecorder, uiStubs } from '../helpers/fleet-harness'
import { globalPermissionsStub } from '../helpers/permission-nav'

const page = webFile('pages', 'admin', 'outbox.vue')
const row = (over: Record<string, unknown> = {}) => ({
  id: 'row-1', projectId: 'p1', type: 'ticket.updated', eventId: 'evt-1', payload: { secret: 's3' }, headers: { secret: 's3' },
  status: 'dead', attempts: 2, nextAttemptAt: null, leaseUntil: null, owner: null, lastError: 'delivery failed',
  publishedAt: null, createdAt: '2026-01-01', updatedAt: '2026-01-01', ...over,
})

function mountOutbox(get: jest.Mock) {
  const toast = toastRecorder()
  const api = { get }
  const app = mountSfc(page, {
    components: uiStubs,
    alias: { '~/composables/useApi': apiModule },
    globals: {
      useI18n: () => enI18n(), useAppToast: () => toast,
      useApi: () => ({ $api: api }),
      useGlobalPermissions: () => globalPermissionsStub(),
    },
  })
  return { app, toast }
}

describe('/admin/outbox', () => {
  test('status filter uses the shared 40px control class and keeps w-fit', () => {
    const { app } = mountOutbox(jest.fn(async () => ({ items: [], total: 0 })))
    const classes = String(app.one('select')?.props.class)
    expect(classes).toContain('h-10')
    expect(classes).toContain('w-fit')
    app.unmount()
  })

  test('AC-4: changing status select requests pending events', async () => {
    const get = jest.fn(async () => ({ items: [], total: 0 }))
    const { app } = mountOutbox(get)
    const select = app.one('select')
    expect(select).toBeDefined()
    ;(select?.props.onChange as (event: { target: { value: string } }) => void)({ target: { value: 'pending' } })
    await new Promise(resolve => setImmediate(resolve))
    expect(get).toHaveBeenLastCalledWith('/admin/outbox', { query: { status: 'pending' } })
    app.unmount()
  })

  test.each([
    ['AC-5', 'type', 'ticket.updated'], ['AC-6', 'event id', 'evt-1'], ['AC-7', 'attempt count', '2'], ['AC-8', 'last error', 'delivery failed'],
  ])('%s: listed row renders %s as text', async (_ac, _label, text) => {
    const { app } = mountOutbox(jest.fn(async () => ({ items: [row()], total: 1 })))
    await new Promise(resolve => setImmediate(resolve))
    expect(app.text()).toContain(text)
    app.unmount()
  })

  test('AC-9: payload and headers secrets are not rendered', async () => {
    const { app } = mountOutbox(jest.fn(async () => ({ items: [row()], total: 1 })))
    await new Promise(resolve => setImmediate(resolve))
    expect(app.text()).not.toContain('s3')
    app.unmount()
  })

  test('AC-10: English count interpolates listed row count and server total', async () => {
    const { app } = mountOutbox(jest.fn(async () => ({ items: [row(), row({ id: 'row-2' })], total: 7 })))
    await new Promise(resolve => setImmediate(resolve))
    expect(app.text()).toContain('Showing 2 of 7')
    app.unmount()
  })

  test('AC-11 and AC-12: 403 renders admin-only copy without an error toast', async () => {
    const { app, toast } = mountOutbox(jest.fn(async () => { throw new ApiError(403, 'Forbidden') }))
    await new Promise(resolve => setImmediate(resolve))
    expect(app.text()).toContain(enI18n().t('outbox.adminOnly'))
    expect(toast.errors).toEqual([])
    app.unmount()
  })

  test('AC-13: non-403 error is toasted with extracted message', async () => {
    const { toast } = mountOutbox(jest.fn(async () => { throw new ApiError(500, 'Outbox unavailable') }))
    await new Promise(resolve => setImmediate(resolve))
    expect(toast.errors).toEqual(['Outbox unavailable'])
  })

  test('AC-14: non-403 error renders error state', async () => {
    const { app } = mountOutbox(jest.fn(async () => { throw new ApiError(500, 'Outbox unavailable') }))
    await new Promise(resolve => setImmediate(resolve))
    expect(app.text()).toContain(enI18n().t('outbox.error'))
    app.unmount()
  })
})
