/**
 * US-006 — the Admin -> Audit log page's paging, explicit Refresh and its three independent states
 * (forbidden, failed load, empty page). The page mounts for real over the real `useAuditLog`, so
 * every assertion is about a request the page itself made, the URL it wrote, or the DOM it rendered.
 */
import { afterEach, describe, expect, jest, test } from '@jest/globals'
import * as Vue from 'vue'
import { computed, h, reactive, ref, watch } from 'vue'
import type { VNodeChild } from 'vue'
import { mountSfc, webFile } from '../helpers/mount-sfc'
import { enI18n, uiStubs } from '../helpers/fleet-harness'
import { permissionSet } from '~/lib/permissions'
import * as apiModule from '~/composables/useApi'
import { ApiError, extractApiError } from '~/composables/useApi'
import enJson from '../../i18n/locales/en.json'
import zhJson from '../../i18n/locales/zh.json'

const page = webFile('pages', 'admin', 'audit.vue')

type Query = Record<string, string>
type Get = jest.Mock<(path: string, opts?: { query?: Query }) => Promise<unknown>>

/** One entry as `GET /audit` returns it (`AuditEntryDto` with its resolved `display` names). */
const ENTRY = {
  id: 'e1',
  key: 'ticket.create',
  resourceType: 'ticket',
  resourceId: 't1',
  projectId: 'p1',
  actor: { type: 'USER', id: 'u1' },
  onBehalfOf: null,
  origin: 'rest',
  approval: { requiredMode: 'none', satisfiedBy: 'none', approverType: null, approverId: null, requestId: null },
  correlationId: 'c-1',
  summary: 'created',
  display: { actor: 'Ada', onBehalfOf: null, approver: null, project: { slug: 'web', name: 'Web' } },
  createdAt: '2026-10-01T10:00:00.000Z',
}

/** A `GET /audit` page envelope (`toPageResult`) with the requested paging flags. */
function pageOf(records: readonly unknown[], hasNext = false, hasPrev = false) {
  return { records, total: records.length, current: 1, size: 50, hasNext, hasPrev }
}

interface Reply {
  /** One `/audit` outcome per call, in order; the last one repeats. A thrown Error rejects the call. */
  audit?: readonly unknown[]
  /** The `/audit/keys` outcome; a thrown Error rejects it. */
  keys?: unknown
}

/**
 * A `$api.get` double for the two audit endpoints. Each call is scripted, so a test can make the
 * first load succeed and a later one fail — the retained-rows and retained-error cases.
 */
function reference(reply: Reply = {}): Get {
  const audit = reply.audit ?? [pageOf([ENTRY])]
  const keys = reply.keys ?? { keys: ['comment.create', 'ticket.create'] }
  let served = 0
  return jest.fn(async (path: string) => {
    if (path === '/audit/keys') {
      if (keys instanceof Error) throw keys
      return keys
    }
    if (path !== '/audit') throw new Error(`unexpected ${path}`)
    const outcome = audit[Math.min(served, audit.length - 1)]
    served += 1
    if (outcome instanceof Error) throw outcome
    return outcome
  }) as Get
}

/** FilterBar is not part of uiStubs; the page only needs it to render its slot. */
const FilterBar = {
  name: 'StubFilterBar',
  setup(_props: unknown, { slots }: { slots: { default?: () => unknown } }) {
    return () => {
      const rendered = slots.default?.()
      return h('x-stub-stub', { 'data-stub': 'filter-bar' }, (rendered === undefined || rendered === null ? [] : Array.isArray(rendered) ? rendered : [rendered]) as VNodeChild[])
    }
  },
}

/** The real FleetNativeSelect is mounted (fleetComponents), so drop its uiStubs placeholder. */
const { FleetNativeSelect: _nativeSelectStub, ...stubs } = uiStubs

function mountPage(get: Get, query: Record<string, unknown> = {}) {
  const route = reactive({ params: {}, query: { ...query } })
  const replace = jest.fn(async (to: { query: Query }) => { route.query = { ...to.query } })
  const toast = { error: jest.fn(), success: jest.fn() }
  const held = permissionSet(['audit.read'])
  const app = mountSfc(page, {
    components: { ...stubs, FilterBar },
    fleetComponents: ['FleetNativeSelect'],
    // The page's `ApiError` must be the same class the test throws, hence the real module.
    alias: { '~/composables/useApi': apiModule },
    globals: {
      ref, computed, watch, onMounted: Vue.onMounted, onBeforeUnmount: Vue.onBeforeUnmount,
      useI18n: () => enI18n(),
      useAppToast: () => toast,
      useApi: () => ({ $api: { get } }),
      useRoute: () => route,
      useRouter: () => ({ replace }),
      useGlobalPermissions: () => ({
        permissions: computed(() => held),
        pending: ref(false),
        error: ref(null),
        refresh: async () => undefined,
      }),
      definePageMeta: () => undefined,
    },
  })
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 6; i += 1) {
      await new Promise((resolve) => { setImmediate(resolve) })
      await Vue.nextTick()
    }
  }
  const byId = (id: string) => app.find(`[data-testid="${id}"]`)
  const text = (id: string): string => app.textOf(byId(id)[0])
  /** The `disabled` attr a Button stub received; `undefined` when the control never rendered. */
  const disabled = (id: string): unknown => byId(id)[0]?.props.disabled
  /** Every `/audit` query the page sent, in order. */
  const auditQueries = (): Query[] => get.mock.calls.filter(([path]) => path === '/audit').map(([, opts]) => opts?.query ?? {})
  return { app, route, replace, toast, settle, byId, text, disabled, auditQueries }
}

describe('admin audit page paging, refresh and states (Permissions P2 US-006)', () => {
  afterEach(() => jest.clearAllMocks())

  test('AC-1: Next writes page 2 into the URL when the API reports another page', async () => {
    const p = mountPage(reference({ audit: [pageOf([ENTRY], true)] }))
    await p.settle()
    expect(p.disabled('audit-next')).not.toBe(true)
    p.byId('audit-next')[0].props.onClick()
    expect(p.replace).toHaveBeenCalledWith({ query: { page: '2' } })
    p.app.unmount()
  })

  test('AC-2: on page 1 Previous is disabled, and on page 2 it is not', async () => {
    const first = mountPage(reference())
    await first.settle()
    expect(first.disabled('audit-prev')).toBe(true)
    first.app.unmount()

    const second = mountPage(reference(), { page: '2' })
    await second.settle()
    expect(second.disabled('audit-prev')).not.toBe(true)
    second.app.unmount()
  })

  test('AC-3: with hasNext false Next is disabled, and with hasNext true it is not', async () => {
    const last = mountPage(reference({ audit: [pageOf([ENTRY], false)] }))
    await last.settle()
    expect(last.disabled('audit-next')).toBe(true)
    last.app.unmount()

    const more = mountPage(reference({ audit: [pageOf([ENTRY], true)] }))
    await more.settle()
    expect(more.disabled('audit-next')).not.toBe(true)
    more.app.unmount()
  })

  test('AC-4: Previous from page 2 keeps the filters and omits the default page', async () => {
    const p = mountPage(reference(), { page: '2', key: 'ticket.create' })
    await p.settle()
    p.byId('audit-prev')[0].props.onClick()
    expect(p.replace).toHaveBeenCalledWith({ query: { key: 'ticket.create' } })
    p.app.unmount()
  })

  test('AC-5: Refresh re-sends the mount query and never touches the URL', async () => {
    const p = mountPage(reference())
    await p.settle()
    expect(p.auditQueries()).toEqual([{ current: '1', size: '50' }])
    p.byId('audit-refresh')[0].props.onClick()
    await p.settle()
    expect(p.auditQueries()).toEqual([
      { current: '1', size: '50' },
      { current: '1', size: '50' },
    ])
    expect(p.replace).not.toHaveBeenCalled()
    p.app.unmount()
  })

  test('AC-6: a 40003 refusal renders the admin-only message and no table', async () => {
    const p = mountPage(reference({ audit: [new ApiError(40003, 'Forbidden')] }))
    await p.settle()
    expect(p.byId('audit-admin-only')).toHaveLength(1)
    expect(p.text('audit-admin-only')).toContain('administrators')
    expect(p.byId('audit-table')).toHaveLength(0)
    expect(p.byId('audit-row')).toHaveLength(0)
    p.app.unmount()
  })

  test('AC-7: a later 400 toasts extractApiError instead of the raw message', async () => {
    const err = new ApiError(400, 'audit.from must be before audit.to')
    const p = mountPage(reference({ audit: [pageOf([ENTRY]), err] }))
    await p.settle()
    expect(p.toast.error).not.toHaveBeenCalled()
    p.route.query = { key: 'comment.create' }
    await p.settle()
    expect(p.auditQueries()).toHaveLength(2)
    expect(p.toast.error).toHaveBeenCalledTimes(1)
    expect(p.toast.error).toHaveBeenCalledWith(extractApiError(err))
    p.app.unmount()
  })

  test('AC-8: after such a failure the rows of the first load are still on screen', async () => {
    const err = new ApiError(400, 'audit.from must be before audit.to')
    const p = mountPage(reference({ audit: [pageOf([ENTRY]), err] }))
    await p.settle()
    p.route.query = { key: 'comment.create' }
    await p.settle()
    expect(p.byId('audit-row')).toHaveLength(1)
    expect(p.text('audit-row')).toContain('ticket.create')
    expect(p.byId('audit-admin-only')).toHaveLength(0)
    p.app.unmount()
  })

  test('AC-9: a failed key load toasts extractApiError', async () => {
    const err = new ApiError(500, 'key list unavailable')
    const p = mountPage(reference({ keys: err }))
    await p.settle()
    expect(p.toast.error).toHaveBeenCalledWith(extractApiError(err))
    p.app.unmount()
  })

  test('AC-10: a page with no entries shows the empty state and no row', async () => {
    const p = mountPage(reference({ audit: [pageOf([])] }))
    await p.settle()
    expect(p.byId('audit-empty')).toHaveLength(1)
    expect(p.text('audit-empty')).toContain('No audit entries')
    expect(p.byId('audit-row')).toHaveLength(0)
    p.app.unmount()
  })

  test('AC-11: a failed key load still renders the entries of the successful load', async () => {
    const p = mountPage(reference({ keys: new ApiError(500, 'key list unavailable') }))
    await p.settle()
    expect(p.byId('audit-row')).toHaveLength(1)
    expect(p.text('audit-row')).toContain('ticket.create')
    expect(p.byId('audit-empty')).toHaveLength(0)
    p.app.unmount()
  })

  test('AC-12: a 403 refusal renders the admin-only message and no table', async () => {
    const p = mountPage(reference({ audit: [new ApiError(403, 'Forbidden')] }))
    await p.settle()
    expect(p.byId('audit-admin-only')).toHaveLength(1)
    expect(p.byId('audit-table')).toHaveLength(0)
    expect(p.byId('audit-row')).toHaveLength(0)
    p.app.unmount()
  })

  // ───────────────────────────────────────────────────────────────────────────
  // Edges the ACs imply
  // ───────────────────────────────────────────────────────────────────────────

  test('a refusal after a successful load hides the table the reader was studying', async () => {
    const p = mountPage(reference({ audit: [pageOf([ENTRY], true), new ApiError(40003, 'Forbidden')] }))
    await p.settle()
    expect(p.byId('audit-row')).toHaveLength(1)
    p.byId('audit-next')[0].props.onClick()
    await p.settle()
    expect(p.auditQueries()).toHaveLength(2)
    expect(p.byId('audit-admin-only')).toHaveLength(1)
    expect(p.byId('audit-table')).toHaveLength(0)
    expect(p.byId('audit-row')).toHaveLength(0)
    expect(p.toast.error).not.toHaveBeenCalled()
    p.app.unmount()
  })

  test('a forbidden view does not clear the filters, so the reader can still see what was refused', async () => {
    const p = mountPage(reference({ audit: [new ApiError(40003, 'Forbidden')] }), { key: 'ticket.create' })
    await p.settle()
    expect(p.byId('audit-admin-only')).toHaveLength(1)
    expect(p.auditQueries()).toEqual([{ key: 'ticket.create', current: '1', size: '50' }])
    p.app.unmount()
  })

  test('Next keeps the active filters alongside the page number', async () => {
    const p = mountPage(reference({ audit: [pageOf([ENTRY], true)] }), { key: 'ticket.create', actorType: 'AGENT' })
    await p.settle()
    p.byId('audit-next')[0].props.onClick()
    expect(p.replace).toHaveBeenCalledWith({ query: { key: 'ticket.create', actorType: 'AGENT', page: '2' } })
    p.app.unmount()
  })

  test('Refresh reloads the filters the URL now holds, not the ones loaded on mount', async () => {
    const p = mountPage(reference({ audit: [pageOf([ENTRY], true, false)] }))
    await p.settle()
    p.route.query = { page: '2', key: 'ticket.create' }
    await p.settle()
    const [, afterUrl] = p.auditQueries()
    p.byId('audit-refresh')[0].props.onClick()
    await p.settle()
    const queries = p.auditQueries()
    expect(afterUrl).toEqual({ key: 'ticket.create', current: '2', size: '50' })
    expect(queries).toHaveLength(3)
    expect(queries[2]).toEqual(afterUrl)
    expect(p.replace).not.toHaveBeenCalled()
    p.app.unmount()
  })

  test('the new paging and state copy exists in both locales', () => {
    const auditCopy = (locale: unknown): Record<string, string> => ((locale as { admin: { audit: Record<string, string> } }).admin.audit)
    for (const locale of [enJson, zhJson]) {
      const copy = auditCopy(locale)
      for (const key of ['prev', 'next', 'refresh', 'adminOnly', 'empty']) {
        expect(copy[key]?.trim()).toBeTruthy()
      }
    }
  })
})
