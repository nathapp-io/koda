/**
 * US-004 — the Admin -> Audit log page: the URL-held filter row, the resolved table and
 * click-to-filter. The page mounts for real over the real `useAuditLog`, so every assertion is
 * about the requests the page itself makes (`$api.get`) and the URL it writes (`router.replace`).
 */
import { afterEach, describe, expect, jest, test } from '@jest/globals'
import * as Vue from 'vue'
import { computed, h, reactive, ref, watch } from 'vue'
import type { VNodeChild } from 'vue'
import { mountSfc, webFile } from '../helpers/mount-sfc'
import { enI18n, uiStubs } from '../helpers/fleet-harness'
import { permissionSet } from '~/lib/permissions'
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

/** A $api.get double: the two audit endpoints, with the records and keys each test wants. */
function reference(records: readonly unknown[] = [ENTRY], keys: readonly string[] = ['comment.create', 'ticket.create']): Get {
  return jest.fn(async (path: string, opts?: { query?: Query }) => {
    if (path === '/audit/keys') return { keys: [...keys] }
    if (path === '/audit') {
      return { records, total: records.length, current: Number(opts?.query?.current ?? '1'), size: 50, hasNext: false, hasPrev: false }
    }
    throw new Error(`unexpected ${path}`)
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
  const held = permissionSet(['audit.read'])
  const app = mountSfc(page, {
    components: { ...stubs, FilterBar },
    fleetComponents: ['FleetNativeSelect'],
    globals: {
      ref, computed, watch, onMounted: Vue.onMounted, onBeforeUnmount: Vue.onBeforeUnmount,
      useI18n: () => enI18n(),
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
  const rowText = (index = 0): string => app.textOf(byId('audit-row')[index])
  /** Every `/audit` query the page sent, in order. */
  const auditQueries = (): Query[] => get.mock.calls.filter(([path]) => path === '/audit').map(([, opts]) => opts?.query ?? {})
  /** The `value` of every <option> the real FleetNativeSelect rendered under one testid. */
  const optionValues = (id: string): string[] => app.find('option', byId(id)[0]).map((option) => String(option.props.value))
  return { app, route, replace, settle, byId, text, rowText, auditQueries, optionValues }
}

describe('admin audit page (Permissions P2 US-004)', () => {
  afterEach(() => jest.clearAllMocks())

  test('AC-1: mounting with an empty query asks for the first page of 50 entries', async () => {
    const p = mountPage(reference())
    await p.settle()
    expect(p.auditQueries()).toEqual([{ current: '1', size: '50' }])
    p.app.unmount()
  })

  test('AC-2: mounting also loads the key list', async () => {
    const get = reference()
    const p = mountPage(get)
    await p.settle()
    expect(get).toHaveBeenCalledWith('/audit/keys')
    p.app.unmount()
  })

  test('AC-3: the route query is sent as the audit query, with the API paging names', async () => {
    const p = mountPage(reference(), { key: 'ticket.create', actorType: 'AGENT', from: '2026-10-01' })
    await p.settle()
    expect(p.auditQueries()).toEqual([
      { key: 'ticket.create', actorType: 'AGENT', from: '2026-10-01', current: '1', size: '50' },
    ])
    p.app.unmount()
  })

  test('AC-4: a row shows the key, the resolved actor and project, the resource and the summary', async () => {
    const p = mountPage(reference())
    await p.settle()
    expect(p.byId('audit-row')).toHaveLength(1)
    const row = p.rowText()
    for (const value of ['ticket.create', 'Ada', 'web', 'ticket', 't1', 'created']) expect(row).toContain(value)
    expect(p.text('audit-actor')).toContain('Ada')
    expect(p.text('audit-project')).toContain('web')
    expect(p.text('audit-resource')).toContain('ticket')
    expect(p.text('audit-resource')).toContain('t1')
    p.app.unmount()
  })

  test('AC-5: an entry performed on behalf of someone shows that person', async () => {
    const entry = {
      ...ENTRY,
      onBehalfOf: { type: 'USER', id: 'u2' },
      display: { ...ENTRY.display, onBehalfOf: 'Bea' },
    }
    const p = mountPage(reference([entry]))
    await p.settle()
    expect(p.text('audit-actor')).toContain('Bea')
    p.app.unmount()
  })

  test('AC-6: a route-query change reloads the page with the new filter', async () => {
    const p = mountPage(reference())
    await p.settle()
    p.route.query = { projectId: 'p1' }
    await p.settle()
    expect(p.auditQueries()).toEqual([
      { current: '1', size: '50' },
      { projectId: 'p1', current: '1', size: '50' },
    ])
    p.app.unmount()
  })

  test('AC-7: picking a key writes it to the URL and never loads directly', async () => {
    const p = mountPage(reference())
    await p.settle()
    const before = p.auditQueries().length
    // The real FleetNativeSelect turns the native change into `update:modelValue`.
    p.byId('audit-key-filter')[0].props.onChange({ target: { value: 'comment.create' } })
    expect(p.replace).toHaveBeenCalledWith({ query: { key: 'comment.create' } })
    expect(p.auditQueries()).toHaveLength(before)
    p.app.unmount()
  })

  test('AC-8: picking an actor type writes it to the URL', async () => {
    const p = mountPage(reference())
    await p.settle()
    p.byId('audit-actor-type-filter')[0].props.onChange({ target: { value: 'RUNNER' } })
    expect(p.replace).toHaveBeenCalledWith({ query: { actorType: 'RUNNER' } })
    p.app.unmount()
  })

  test('AC-9: setting the from date writes it to the URL and drops the page', async () => {
    const p = mountPage(reference(), { page: '3' })
    await p.settle()
    p.byId('audit-from')[0].props['onUpdate:modelValue']('2026-10-01')
    expect(p.replace).toHaveBeenCalledWith({ query: { from: '2026-10-01' } })
    p.app.unmount()
  })

  test('AC-10: clicking a row agent filters on that actor', async () => {
    const entry = { ...ENTRY, actor: { type: 'AGENT', id: 'a1' }, display: { ...ENTRY.display, actor: 'Runner' } }
    const p = mountPage(reference([entry]))
    await p.settle()
    p.byId('audit-actor')[0].props.onClick()
    expect(p.replace).toHaveBeenCalledWith({ query: { actorType: 'AGENT', actorId: 'a1' } })
    p.app.unmount()
  })

  test('AC-11: clicking a row project filters on that project', async () => {
    const p = mountPage(reference())
    await p.settle()
    p.byId('audit-project')[0].props.onClick()
    expect(p.replace).toHaveBeenCalledWith({ query: { projectId: 'p1' } })
    p.app.unmount()
  })

  test('AC-12: clicking a row resource filters on that resource', async () => {
    const p = mountPage(reference())
    await p.settle()
    p.byId('audit-resource')[0].props.onClick()
    expect(p.replace).toHaveBeenCalledWith({ query: { resourceType: 'ticket', resourceId: 't1' } })
    p.app.unmount()
  })

  test('AC-13: a URL key that the key list does not offer is still an option', async () => {
    const p = mountPage(reference([ENTRY], ['comment.create']), { key: 'legacy.key' })
    await p.settle()
    expect(p.optionValues('audit-key-filter')).toEqual(['', 'comment.create', 'legacy.key'])
    expect(p.byId('audit-key-filter')[0].props.value).toBe('legacy.key')
    p.app.unmount()
  })

  test('AC-14: a deleted principal falls back to its id', async () => {
    const entry = { ...ENTRY, actor: { type: 'USER', id: 'ghost' }, display: { ...ENTRY.display, actor: null } }
    const p = mountPage(reference([entry]))
    await p.settle()
    expect(p.text('audit-actor')).toContain('ghost')
    p.app.unmount()
  })

  test('the project cell falls back to the raw project id, then to a dash', async () => {
    const unresolved = { ...ENTRY, id: 'e2', projectId: 'p9', display: { ...ENTRY.display, project: null } }
    const none = { ...ENTRY, id: 'e3', projectId: null, display: { ...ENTRY.display, project: null } }
    const p = mountPage(reference([unresolved, none]))
    await p.settle()
    const cells = p.byId('audit-project')
    expect(cells).toHaveLength(1)
    expect(p.app.textOf(cells[0])).toBe('p9')
    expect(p.app.textOf(p.byId('audit-row')[1])).toContain('-')
    p.app.unmount()
  })

  test('the page is titled and subtitled, offers the four actor types and labels UTC days', async () => {
    const p = mountPage(reference())
    await p.settle()
    const header = p.app.find('[data-stub="page-header"]')[0]
    expect(header.props.title).toBe('Audit log')
    expect(String(header.props.subtitle)).toBe('Every write the API recorded, with the actor, project and resource it touched.')
    expect(p.optionValues('audit-actor-type-filter')).toEqual(['', 'USER', 'AGENT', 'RUNNER', 'SYSTEM'])
    expect(p.byId('audit-from')[0].props.type).toBe('date')
    expect(p.byId('audit-to')[0].props.type).toBe('date')
    expect(p.app.text()).toContain('UTC')
    p.app.unmount()
  })

  test('the actor-type labels are dynamic keys, so both locales carry all four', () => {
    // `used-keys-exist` scans literal keys only; `admin.audit.actorType.${type}` is built in the
    // template, so the four values are pinned here for en and zh.
    const auditCopy = (locale: unknown): Record<string, string> =>
      ((locale as { admin: { audit: { actorType: Record<string, string> } } }).admin.audit.actorType)
    for (const locale of [enJson, zhJson]) {
      const labels = auditCopy(locale)
      for (const type of ['USER', 'AGENT', 'RUNNER', 'SYSTEM']) expect(labels[type]?.trim()).toBeTruthy()
    }
  })
})
