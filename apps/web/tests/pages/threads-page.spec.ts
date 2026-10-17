import { afterEach, describe, expect, jest, test } from '@jest/globals'
import * as Vue from 'vue'
import { ref, computed, watch, nextTick } from 'vue'
import { mountSfc, webFile, loadSfc } from '../helpers/mount-sfc'
import type { FakeNode, Mounted } from '../helpers/mount-sfc'
import { uiStubs, i18nStub, toastRecorder } from '../helpers/fleet-harness'
import * as apiModule from '../../composables/useApi'
import { useThreads } from '~/composables/useThreads'
import type { ThreadDto } from '~/lib/thread-types'

const g = globalThis as Record<string, unknown>

const pageFile = webFile('pages', '[project]', 'threads', 'index.vue')

const listItem = (overrides: Record<string, unknown> = {}): ThreadDto => ({
  id: 'th1',
  repoId: 'r1',
  baseRef: 'main',
  feature: 'f1',
  title: 'Auth spec',
  createdById: 'u1',
  runnerId: 'rn1',
  backend: { kind: 'native', model: 'gpt-5' },
  status: 'ACTIVE',
  archivedAt: null,
  skills: [],
  maxCostUsd: '5',
  costUsd: '0',
  tokens: null,
  specPath: '.nax/features/f1/prd.json',
  pendingQuestion: null,
  session: null,
  lastActivityAt: '2026-10-14T00:00:00.000Z',
  createdAt: '2026-10-14T00:00:00.000Z',
  activeJob: null,
  ...overrides,
})

type Role = { canManage: boolean; viewerRole: string | null }
const DEVELOPER: Role = { canManage: false, viewerRole: 'DEVELOPER' }
const ADMIN: Role = { canManage: true, viewerRole: 'ADMIN' }
const VIEWER: Role = { canManage: false, viewerRole: 'VIEWER' }

/**
 * The page under test is `pages/[project]/threads/index.vue` (US-004). It auto-imports useThreads,
 * useProjectViewerRole and useProjectMemberNames; the test overrides those through mount-sfc
 * globals, exactly as mount-sfc's NUXT_AUTO_IMPORTS addition is meant to allow. The real
 * ThreadListTable is registered as a component so the row is produced by the component's own
 * template, not by a stub.
 */
function mountPage(over: {
  role?: Role
  threadsEnabled?: boolean
  threads?: ThreadDto[]
  load?: jest.Mock
  /** When given, the page gets the REAL useThreads over this `$api`, so a race is decided for real. */
  api?: { get: jest.Mock }
  /** When given, the members read is settled by the test instead of answering at once. */
  membersLoad?: jest.Mock
} = {}) {
  // `useThreads` resolves true once its read applied (koda#294); the default stub reports that.
  const load: jest.Mock<() => Promise<boolean>> = over.load ?? jest.fn<() => Promise<boolean>>(async () => true)
  const replace = jest.fn(async (_to: unknown) => undefined)
  const stubList = {
    threads: ref(over.threads ?? [listItem()]),
    threadsEnabled: ref(over.threadsEnabled ?? true),
    status: ref<'ACTIVE' | 'ARCHIVED'>('ACTIVE'),
    load,
  }
  const get = over.api?.get ?? jest.fn(async () => ({}))
  // The real useThreads reads its `$api` through the Nuxt auto-import, which resolves on
  // globalThis when the composable is imported directly by the test instead of by mount-sfc.
  if (over.api) g.useApi = () => ({ $api: { get } })
  const app = mountSfc(pageFile, {
    components: {
      ...uiStubs,
      FleetThreadsThreadListTable: loadSfc(webFile('components', 'fleet', 'threads', 'ThreadListTable.vue'), { useI18n: () => i18nStub() }),
    },
    alias: { '~/composables/useApi': apiModule },
    globals: {
      ref, computed, watch, nextTick,
      onMounted: Vue.onMounted,
      definePageMeta: () => undefined,
      useI18n: () => i18nStub(),
      useAppToast: () => toastRecorder(),
      useApi: () => ({ $api: { get } }),
      useRoute: () => ({ params: { project: 'web' }, query: {} }),
      useRouter: () => ({ replace }),
      useAuth: () => ({ user: ref({ id: 'me', email: 'a@k.t', role: 'MEMBER' }) }),
      useProjectViewerRole: () => ({ data: ref(over.role ?? VIEWER) }),
      useProjectMemberNames: () => ({ load: over.membersLoad ?? jest.fn(async () => undefined), nameOf: () => 'Dana' }),
      useThreads: over.api ? useThreads : () => stubList,
    },
  })
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 6; i += 1) {
      await new Promise((resolve) => { setImmediate(resolve) })
      await Vue.nextTick()
    }
  }
  return { app, load, replace, settle }
}

/** The first node whose `to` or `href` is the given path. */
function linkTo(app: Mounted, to: string): FakeNode | undefined {
  const found: FakeNode[] = []
  const walk = (node: FakeNode): void => {
    if (node.props.to === to || node.props.href === to) found.push(node)
    node.children.forEach(walk)
  }
  walk(app.root)
  return found[0]
}

/** Clicks the first node whose rendered text includes `label` (the Active|Archived switch). */
function clickByLabel(app: Mounted, label: string): void {
  const found: FakeNode[] = []
  const walk = (node: FakeNode): void => {
    if (typeof node.props.onClick === 'function' && app.textOf(node).includes(label)) found.push(node)
    node.children.forEach(walk)
  }
  walk(app.root)
  expect(found.length).toBeGreaterThan(0)
  ;(found[0].props.onClick as () => void)()
}

/** The `aria-pressed` of the first button whose text includes `label` (the Active|Archived switch). */
function pressed(app: Mounted, label: string): unknown {
  const found = app.find('button').find(node => app.textOf(node).includes(label))
  expect(found).toBeDefined()
  return found?.props['aria-pressed']
}

afterEach(() => {
  delete g.useApi
})

describe('US-004 AC11-AC15: the project threads list page', () => {
  test('AC11: a DEVELOPER with threadsEnabled true sees the New thread link to /web/threads/new', async () => {
    const m = mountPage({ role: DEVELOPER, threadsEnabled: true })
    await m.settle()

    expect(linkTo(m.app, '/web/threads/new')).toBeDefined()
    m.app.unmount()
  })

  test('AC12: threadsEnabled false hides the New thread link even for a project ADMIN', async () => {
    const m = mountPage({ role: ADMIN, threadsEnabled: false })
    await m.settle()

    expect(linkTo(m.app, '/web/threads/new')).toBeUndefined()
    m.app.unmount()
  })

  test('AC13: threadsEnabled true does not show the New thread link for a VIEWER', async () => {
    const m = mountPage({ role: VIEWER, threadsEnabled: true })
    await m.settle()

    expect(linkTo(m.app, '/web/threads/new')).toBeUndefined()
    m.app.unmount()
  })

  test('AC14: switching the page to Archived calls useThreads().load with the status ARCHIVED', async () => {
    const m = mountPage({ role: DEVELOPER })
    await m.settle()

    clickByLabel(m.app, 'fleet.threads.list.archived')
    await m.settle()

    expect(m.load).toHaveBeenCalledWith('ARCHIVED')
    m.app.unmount()
  })

  test('AC15: a stubbed useThreads holding [t] renders a ThreadListTable row linking to /web/threads/th1', async () => {
    const m = mountPage({ role: DEVELOPER, threads: [listItem()] })
    await m.settle()

    expect(linkTo(m.app, '/web/threads/th1')).toBeDefined()
    m.app.unmount()
  })
})

/**
 * koda#294 (2aw-D13): Archived then Active, clicked quickly. The page mounts the REAL useThreads over
 * a `$api` the test settles by hand, so the test sees the whole chain — the composable's generation
 * guard decides which read applied, and the page's own token decides which read may touch the URL,
 * the error state and the spinner.
 */
describe('koda#294: out-of-order status reads on the project threads page', () => {
  interface ThreadsResponse {
    items: ThreadDto[]
    threadsEnabled: boolean
  }

  interface Read {
    status: string
    resolve: (value: ThreadsResponse) => void
    reject: (error: Error) => void
  }

  /** A `$api.get` that answers nothing until the test settles that read, in the order it chooses. */
  function queuedApi(): { get: jest.Mock; reads: Read[] } {
    const reads: Read[] = []
    const get = jest.fn((_path: string, options?: { query?: Record<string, string> }) => {
      let resolve!: (value: ThreadsResponse) => void
      let reject!: (error: Error) => void
      const promise = new Promise<ThreadsResponse>((done, fail) => {
        resolve = done
        reject = fail
      })
      reads.push({ status: options?.query?.status ?? '', resolve, reject })
      return promise
    })
    return { get, reads }
  }

  const activeRows = [listItem({ id: 'th1' })]
  const archivedRows = [listItem({ id: 'th-old', status: 'ARCHIVED' })]

  /** Mount, settle the initial ACTIVE read, then click Archived and Active without settling either. */
  async function startRace() {
    const api = queuedApi()
    const m = mountPage({ role: DEVELOPER, api: { get: api.get } })
    await m.settle()
    // The page's own first read: ACTIVE, from the empty query.
    expect(api.reads.map(read => read.status)).toEqual(['ACTIVE'])
    api.reads[0].resolve({ items: activeRows, threadsEnabled: true })
    await m.settle()

    clickByLabel(m.app, 'fleet.threads.list.archived')
    clickByLabel(m.app, 'fleet.threads.list.active')
    expect(api.reads.map(read => read.status)).toEqual(['ACTIVE', 'ARCHIVED', 'ACTIVE'])
    return { m, api, archived: api.reads[1], active: api.reads[2] }
  }

  test('AC-6: the Active read answering first leaves the Active toggle pressed', async () => {
    const { m, archived, active } = await startRace()

    active.resolve({ items: activeRows, threadsEnabled: true })
    await m.settle()
    archived.resolve({ items: archivedRows, threadsEnabled: true })
    await m.settle()

    expect(pressed(m.app, 'fleet.threads.list.active')).toBe(true)
    expect(pressed(m.app, 'fleet.threads.list.archived')).toBe(false)
    m.app.unmount()
  })

  test('AC-7: the URL query ends on Active (status absent), not on ARCHIVED', async () => {
    const { m, archived, active } = await startRace()

    active.resolve({ items: activeRows, threadsEnabled: true })
    await m.settle()
    archived.resolve({ items: archivedRows, threadsEnabled: true })
    await m.settle()

    const queries = m.replace.mock.calls.map(([to]) => (to as { query: Record<string, unknown> }).query)
    // The overtaken Archived read replaces nothing: only the applied Active read touched the URL.
    expect(queries).toHaveLength(1)
    expect(queries[0]?.status).toBeUndefined()
    m.app.unmount()
  })

  test('AC-8: a stale Archived read that fails after the Active read applied shows no error state', async () => {
    const { m, archived, active } = await startRace()

    active.resolve({ items: activeRows, threadsEnabled: true })
    await m.settle()
    archived.reject(new Error('network'))
    await m.settle()

    expect(m.app.find('[data-stub="error-state"]')).toHaveLength(0)
    expect(linkTo(m.app, '/web/threads/th1')).toBeDefined()
    expect(m.replace.mock.calls.map(([to]) => (to as { query: Record<string, unknown> }).query.status)).toEqual([undefined])
    m.app.unmount()
  })

  test('AC-9: a stale read that answers first does not clear the newer read\'s loading state', async () => {
    const { m, archived, active } = await startRace()

    // The older ARCHIVED read answers while the newer ACTIVE read is still in flight.
    archived.resolve({ items: archivedRows, threadsEnabled: true })
    await m.settle()

    expect(m.app.find('[data-stub="loading-state"]')).toHaveLength(1)
    // Nothing is drawn from the stale read either.
    expect(linkTo(m.app, '/web/threads/th-old')).toBeUndefined()

    // The newer read still owns the state: its own answer is what ends the spinner.
    active.resolve({ items: activeRows, threadsEnabled: true })
    await m.settle()

    expect(m.app.find('[data-stub="loading-state"]')).toHaveLength(0)
    expect(linkTo(m.app, '/web/threads/th1')).toBeDefined()
    m.app.unmount()
  })

  /**
   * The members read is a second request inside `loadPage`, and it answers on its own schedule. An
   * Archived load whose thread read applied *before* Active was clicked only releases from its
   * `Promise.all` when its members request answers — which can be after Active has run to
   * completion. That finished-but-overtaken load must not write the URL back to Archived.
   */
  test('AC-7 (regression): an overtaken load released late by its members read writes nothing', async () => {
    const members: Array<{ resolve: () => void }> = []
    const membersLoad = jest.fn(() => new Promise<void>((resolve) => { members.push({ resolve }) }))
    const api = queuedApi()
    const m = mountPage({ role: DEVELOPER, api: { get: api.get }, membersLoad })
    await m.settle()

    // The page's own first read, with its members read settled so the page is idle before the race.
    api.reads[0].resolve({ items: activeRows, threadsEnabled: true })
    await m.settle()
    members[0].resolve()
    await m.settle()

    const queries = (): Array<Record<string, unknown>> =>
      m.replace.mock.calls.map(([to]) => (to as { query: Record<string, unknown> }).query)
    // The first read only fills the list; only a toggle writes the URL.
    expect(queries()).toHaveLength(0)

    // Archived: its thread read applies at once, its members read stays pending.
    clickByLabel(m.app, 'fleet.threads.list.archived')
    api.reads[1].resolve({ items: archivedRows, threadsEnabled: true })
    await m.settle()
    expect(queries()).toHaveLength(0)

    // Active overtakes it and runs all the way to completion.
    clickByLabel(m.app, 'fleet.threads.list.active')
    api.reads[2].resolve({ items: activeRows, threadsEnabled: true })
    await m.settle()
    members[2].resolve()
    await m.settle()
    expect(queries()).toEqual([{ status: undefined }])

    // The late members answer releases the overtaken Archived load: it writes nothing at all.
    members[1].resolve()
    await m.settle()

    expect(queries()).toEqual([{ status: undefined }])
    expect(pressed(m.app, 'fleet.threads.list.active')).toBe(true)
    expect(linkTo(m.app, '/web/threads/th1')).toBeDefined()
    expect(linkTo(m.app, '/web/threads/th-old')).toBeUndefined()
    m.app.unmount()
  })
})
