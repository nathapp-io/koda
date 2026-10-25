/**
 * US-005 — the Admin -> Audit log page's active-filter chips: what each chip reads and what its
 * remove button writes to the URL. The page mounts for real over the real `useAuditLog`, so every
 * assertion is about the rendered chip and the `router.replace` the page itself performs.
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

/** The AGENT a1 that AC-1 filters on, resolved to the name 'bot'. */
const BOT = { ...ENTRY, actor: { type: 'AGENT', id: 'a1' }, display: { ...ENTRY.display, actor: 'bot' } }

/** An entry approved by u9, resolved to the name 'Cara'. */
const APPROVED = {
  ...ENTRY,
  approval: { requiredMode: 'self', satisfiedBy: 'human', approverType: 'USER', approverId: 'u9', requestId: 'r1' },
  display: { ...ENTRY.display, approver: 'Cara' },
}

/** A $api.get double: the two audit endpoints, with the records the test wants. */
function reference(records: readonly unknown[] = [ENTRY]): Get {
  return jest.fn(async (path: string) => {
    if (path === '/audit/keys') return { keys: ['comment.create', 'ticket.create'] }
    if (path === '/audit') {
      return { records, total: records.length, current: 1, size: 50, hasNext: false, hasPrev: false }
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
  // US-006 made the page toast a failed load, so the mount needs a toast; these assertions do not read it.
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
  /** The chips the page renders, one node per active id filter. */
  const chips = () => byId('audit-chip')
  /** The one chip for a filter kind (`actor`, `approver`, `project`, `resource`, `correlation`). */
  const chip = (filter: string) => app.find(`[data-filter="${filter}"]`)
  /** Everything a chip reads on screen — strictly its label, because the remove icon has no text. */
  const chipText = (filter: string): string => app.textOf(chip(filter)[0])
  /** Clicks the remove button that lives inside one chip. */
  const remove = (filter: string): void => {
    const button = app.find('[data-testid="audit-chip-remove"]', chip(filter)[0])
    expect(button).toHaveLength(1)
    button[0].props.onClick()
  }
  return { app, route, replace, settle, byId, chips, chip, chipText, remove }
}

describe('admin audit page active-filter chips (Permissions P2 US-005)', () => {
  afterEach(() => jest.clearAllMocks())

  test('AC-1: the actor chip shows the resolved actor name from the loaded entry', async () => {
    const p = mountPage(reference([BOT]), { actorType: 'AGENT', actorId: 'a1' })
    await p.settle()
    expect(p.chip('actor')).toHaveLength(1)
    expect(p.chipText('actor')).toContain('bot')
    expect(p.chipText('actor')).not.toContain('a1')
    p.app.unmount()
  })

  test('AC-2: removing the actor chip drops actorType and actorId and keeps the key filter', async () => {
    const p = mountPage(reference([BOT]), { actorType: 'AGENT', actorId: 'a1', key: 'ticket.create' })
    await p.settle()
    p.remove('actor')
    expect(p.replace).toHaveBeenCalledWith({ query: { key: 'ticket.create' } })
    p.app.unmount()
  })

  test('AC-3: an approver the loaded page cannot resolve still shows a useful raw-id chip', async () => {
    const p = mountPage(reference(), { approverId: 'u9' })
    await p.settle()
    expect(p.chip('approver')).toHaveLength(1)
    expect(p.chipText('approver')).toContain('u9')
    p.app.unmount()
  })

  test('AC-4: removing the project chip drops projectId and keeps the key filter', async () => {
    const p = mountPage(reference(), { projectId: 'p1', key: 'ticket.create' })
    await p.settle()
    expect(p.chipText('project')).toContain('web')
    p.remove('project')
    expect(p.replace).toHaveBeenCalledWith({ query: { key: 'ticket.create' } })
    p.app.unmount()
  })

  test('AC-5: removing the resource chip drops both resourceType and resourceId', async () => {
    const p = mountPage(reference(), { resourceType: 'ticket', resourceId: 't1' })
    await p.settle()
    expect(p.chipText('resource')).toContain('ticket/t1')
    p.remove('resource')
    expect(p.replace).toHaveBeenCalledWith({ query: {} })
    p.app.unmount()
  })

  test('AC-6: removing the correlation chip drops correlationId', async () => {
    const p = mountPage(reference(), { correlationId: 'c-1' })
    await p.settle()
    expect(p.chipText('correlation')).toContain('c-1')
    p.remove('correlation')
    expect(p.replace).toHaveBeenCalledWith({ query: {} })
    p.app.unmount()
  })

  // ───────────────────────────────────────────────────────────────────────────
  // Labels: the resolved name when the loaded page carries the id, the id otherwise
  // ───────────────────────────────────────────────────────────────────────────

  test('the approver chip shows the loaded approver name when an entry carries that id', async () => {
    const p = mountPage(reference([APPROVED]), { approverId: 'u9' })
    await p.settle()
    expect(p.chipText('approver')).toContain('Cara')
    expect(p.chipText('approver')).not.toContain('u9')
    p.app.unmount()
  })

  test('an actor chip falls back to the raw id when the page holds no such actor', async () => {
    const p = mountPage(reference(), { actorType: 'AGENT', actorId: 'a7' })
    await p.settle()
    expect(p.chipText('actor')).toContain('a7')
    p.app.unmount()
  })

  test('an actor whose name did not resolve falls back to the raw id, not a blank chip', async () => {
    const ghost = { ...ENTRY, actor: { type: 'USER', id: 'ghost' }, display: { ...ENTRY.display, actor: null } }
    const p = mountPage(reference([ghost]), { actorType: 'USER', actorId: 'ghost' })
    await p.settle()
    expect(p.chipText('actor')).toContain('ghost')
    p.app.unmount()
  })

  test('the project chip falls back to the raw project id when no entry resolves it', async () => {
    const p = mountPage(reference(), { projectId: 'p9' })
    await p.settle()
    expect(p.chipText('project')).toContain('p9')
    p.app.unmount()
  })

  test('a resource filter set on one side only shows that side', async () => {
    const p = mountPage(reference(), { resourceId: 't1' })
    await p.settle()
    expect(p.chipText('resource')).toContain('t1')
    expect(p.chipText('resource')).not.toContain('/')
    p.app.unmount()
  })

  test('the actor name comes from the first loaded entry carrying the id', async () => {
    const other = { ...BOT, id: 'e2', display: { ...BOT.display, actor: 'second' } }
    const p = mountPage(reference([BOT, other]), { actorType: 'AGENT', actorId: 'a1' })
    await p.settle()
    expect(p.chipText('actor')).toContain('bot')
    expect(p.chipText('actor')).not.toContain('second')
    p.app.unmount()
  })

  // ───────────────────────────────────────────────────────────────────────────
  // The chip row itself: one chip per id filter, in a stable order
  // ───────────────────────────────────────────────────────────────────────────

  test('no id filter set renders no chip at all', async () => {
    const p = mountPage(reference(), { key: 'ticket.create', actorType: 'AGENT', from: '2026-10-01' })
    await p.settle()
    expect(p.chips()).toHaveLength(0)
    p.app.unmount()
  })

  test('every id filter renders its own chip, actor first and correlation last', async () => {
    const query = {
      actorType: 'AGENT', actorId: 'a1', approverId: 'u9', projectId: 'p1',
      resourceType: 'ticket', resourceId: 't1', correlationId: 'c-1',
    }
    const p = mountPage(reference([BOT, APPROVED]), query)
    await p.settle()
    expect(p.chips().map((node) => node.props['data-filter'])).toEqual([
      'actor', 'approver', 'project', 'resource', 'correlation',
    ])
    const labels = p.chips().map((node) => p.app.textOf(node))
    for (const [index, value] of ['bot', 'Cara', 'web', 'ticket/t1', 'c-1'].entries()) {
      expect(labels[index]).toContain(value)
    }
    p.app.unmount()
  })

  test('removing a chip keeps every other filter and restarts at page 1', async () => {
    const p = mountPage(reference(), { key: 'ticket.create', correlationId: 'c-1', page: '3' })
    await p.settle()
    p.remove('correlation')
    expect(p.replace).toHaveBeenCalledWith({ query: { key: 'ticket.create' } })
    p.app.unmount()
  })

  test('each chip remove button is labelled with the chip it removes', async () => {
    const p = mountPage(reference([BOT]), { actorType: 'AGENT', actorId: 'a1' })
    await p.settle()
    const button = p.app.find('[data-testid="audit-chip-remove"]', p.chip('actor')[0])[0]
    expect(button.props['aria-label']).toBe('Remove filter: bot')
    p.app.unmount()
  })

  test('the chip kind labels are dynamic keys, so both locales carry all five', () => {
    // `used-keys-exist` scans literal keys only; `admin.audit.chip.${filter}` is built in the
    // template, so the five values are pinned here for en and zh.
    const chipCopy = (locale: unknown): Record<string, string> =>
      ((locale as { admin: { audit: { chip: Record<string, string> } } }).admin.audit.chip)
    for (const locale of [enJson, zhJson]) {
      const labels = chipCopy(locale)
      for (const filter of ['actor', 'approver', 'project', 'resource', 'correlation', 'remove']) {
        expect(labels[filter]?.trim()).toBeTruthy()
      }
    }
  })
})
