/**
 * US-007 — the audit page's row detail: the expand control (AC-1) and the "Show related" navigation
 * that replaces every other filter with the row's correlation id (AC-7).
 *
 * Same harness as `admin-audit.spec.ts`: the page mounts for real over the real `useAuditLog`, and
 * the detail it renders is the real `components/audit/AuditEntryDetail.vue` the page imports — not a
 * stub — so these assertions cover the wiring between the two.
 */
import { afterEach, describe, expect, jest, test } from '@jest/globals'
import * as Vue from 'vue'
import { computed, h, reactive, ref, watch } from 'vue'
import type { VNodeChild } from 'vue'
import { mountSfc, webFile } from '../helpers/mount-sfc'
import { enI18n, uiStubs } from '../helpers/fleet-harness'
import { permissionSet } from '~/lib/permissions'

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
  approval: { requiredMode: 'human', satisfiedBy: 'human', approverType: 'USER', approverId: 'u2', requestId: 'pa1' },
  correlationId: 'c-1',
  summary: 'created',
  display: { actor: 'Ada', onBehalfOf: null, approver: 'Bea', project: { slug: 'web', name: 'Web' } },
  createdAt: '2026-10-01T10:00:00.000Z',
}

/** A second entry, so a test can prove the detail belongs to the row that was expanded. */
const OTHER = { ...ENTRY, id: 'e2', key: 'comment.create', correlationId: 'c-2', summary: 'commented' }

/** A $api.get double for the two audit endpoints. */
function reference(records: readonly unknown[] = [ENTRY, OTHER]): Get {
  return jest.fn(async (path: string) => {
    if (path === '/audit/keys') return { keys: ['comment.create', 'ticket.create'] }
    if (path === '/audit') return { records: [...records], total: records.length, current: 1, size: 50, hasNext: false, hasPrev: false }
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
  const toast = { error: jest.fn(), success: jest.fn() }
  const held = permissionSet(['audit.read'])
  const app = mountSfc(page, {
    components: { ...stubs, FilterBar },
    fleetComponents: ['FleetNativeSelect'],
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
  const text = (id: string): string => {
    const found = byId(id)[0]
    if (!found) throw new Error(`no ${id} in: ${app.text()}`)
    return app.textOf(found)
  }
  /** Expands the row at `index` with its own audit-expand control. */
  const expand = (index = 0): void => { byId('audit-expand')[index].props.onClick() }
  return { app, route, replace, toast, settle, byId, text, expand }
}

describe('admin audit page row detail (Permissions P2 US-007)', () => {
  afterEach(() => jest.clearAllMocks())

  test('AC-1: expanding a row renders its detail with that entry correlation id', async () => {
    const p = mountPage(reference())
    await p.settle()
    expect(p.byId('audit-detail')).toHaveLength(0)

    p.expand(1)
    await p.settle()

    expect(p.byId('audit-detail')).toHaveLength(1)
    expect(p.text('audit-detail')).toContain('c-2')
    expect(p.text('audit-detail')).not.toContain('c-1')
    p.app.unmount()
  })

  test('AC-1: the detail is the real component, with its labels, its approver and its approval request', async () => {
    const p = mountPage(reference())
    await p.settle()
    p.expand(0)
    await p.settle()

    const detail = p.text('audit-detail')
    expect(detail).toContain('Correlation')
    expect(detail).toContain('Satisfied by')
    expect(detail).toContain('Bea')
    expect(detail).toContain('pa1')
    expect(detail).toContain('2026-10-01T10:00:00.000Z')
    p.app.unmount()
  })

  test('AC-1: expanding the same row again collapses it', async () => {
    const p = mountPage(reference())
    await p.settle()
    p.expand(0)
    await p.settle()
    expect(p.byId('audit-detail')).toHaveLength(1)

    p.expand(0)
    await p.settle()
    expect(p.byId('audit-detail')).toHaveLength(0)
    p.app.unmount()
  })

  test('AC-1: one row is expanded at a time', async () => {
    const p = mountPage(reference())
    await p.settle()
    p.expand(0)
    await p.settle()
    p.expand(1)
    await p.settle()

    expect(p.byId('audit-detail')).toHaveLength(1)
    expect(p.text('audit-detail')).toContain('c-2')
    p.app.unmount()
  })

  test('AC-7: Show related replaces every filter and the page with the row correlation id', async () => {
    const p = mountPage(reference(), { key: 'ticket.create', page: '2' })
    await p.settle()
    p.expand(0)
    await p.settle()

    p.byId('audit-show-related')[0].props.onClick()

    expect(p.replace).toHaveBeenCalledWith({ query: { correlationId: 'c-1' } })
    p.app.unmount()
  })

  test('AC-7: the related view is a fresh page 1 with no other filter carried over', async () => {
    const p = mountPage(reference(), { key: 'ticket.create', page: '2', actorType: 'AGENT', actorId: 'a1' })
    await p.settle()
    p.expand(0)
    await p.settle()

    p.byId('audit-show-related')[0].props.onClick()
    await p.settle()

    // The URL now holds only the correlation filter, so exactly that is what the page asks for.
    expect(p.replace).toHaveBeenCalledWith({ query: { correlationId: 'c-1' } })
    p.app.unmount()
  })
})
