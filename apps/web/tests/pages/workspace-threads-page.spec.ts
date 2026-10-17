import { afterEach, describe, expect, jest, test } from '@jest/globals'
import * as Vue from 'vue'
import { ref, watch, nextTick, computed } from 'vue'
import { mountSfc, loadSfc, webFile } from '../helpers/mount-sfc'
import type { FakeNode, Mounted } from '../helpers/mount-sfc'
import { uiStubs, i18nStub } from '../helpers/fleet-harness'
import * as apiModule from '../../composables/useApi'
import { useWorkspaceThreads } from '~/composables/useWorkspaceThreads'
import type { ThreadDto } from '~/lib/thread-types'

/**
 * US-005 AC-1..AC-5: pages/threads/index.vue — the signed-in user's own thread list.
 *
 * The page auto-imports the real `useWorkspaceThreads` (US-004), which reads the top-level
 * `/threads` through `useApi()`. The test wires that real composable in and stubs `$api`, so the
 * assertion is on the request the page actually sends, not on a composable double.
 */
const pageFile = webFile('pages', 'threads', 'index.vue')

/** A WORKSPACE thread as `GET /threads` returns it: personal, project-less, with a home project. */
const workspaceItem = (overrides: Record<string, unknown> = {}): ThreadDto => ({
  id: 'th1',
  kind: 'WORKSPACE',
  repoId: null,
  baseRef: null,
  feature: null,
  homeProject: { slug: 'web', name: 'Sandbox' },
  title: 'Plan the rollout',
  createdById: 'u1',
  runnerId: null,
  backend: { kind: 'native', model: 'gpt-5' },
  status: 'ACTIVE',
  archivedAt: null,
  skills: [],
  maxCostUsd: '5',
  costUsd: '0',
  tokens: null,
  specPath: null,
  pendingQuestion: null,
  session: null,
  lastActivityAt: '2026-10-14T00:00:00.000Z',
  createdAt: '2026-10-14T00:00:00.000Z',
  activeJob: null,
  writtenPaths: [],
  publishedSha: null,
  specPublished: false,
  lastWrite: null,
  ...overrides,
})

const g = globalThis as Record<string, unknown>

interface GetCall {
  path: string
  query: Record<string, string> | undefined
}

/**
 * Mounts the real page with the real useWorkspaceThreads over a stubbed `$api`. `useApi` must be
 * reachable both as a mount-sfc global (the page's own `useApi`?) and as a global for the directly
 * imported composable, whose `useApi()` reference is a Nuxt auto-import — hence `g.useApi`.
 */
function mountPage(over: { items?: ThreadDto[]; moreItems?: ThreadDto[]; threadsEnabled?: boolean } = {}) {
  const calls: GetCall[] = []
  const get = jest.fn(async (path: string, options?: { query?: Record<string, string> }) => {
    calls.push({ path, query: options?.query })
    if (options?.query?.page === '2') return { items: over.moreItems ?? [], threadsEnabled: over.threadsEnabled ?? true }
    return { items: over.items ?? [workspaceItem()], threadsEnabled: over.threadsEnabled ?? true }
  })
  g.useApi = () => ({ $api: { get } })
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
      useApi: () => ({ $api: { get } }),
      useRoute: () => ({ params: {}, query: {} }),
      useAuth: () => ({ user: ref({ id: 'u1', name: 'Dana', email: 'dana@k.t' }) }),
      useWorkspaceThreads,
    },
  })
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 6; i += 1) {
      await new Promise((resolve) => { setImmediate(resolve) })
      await Vue.nextTick()
    }
  }
  return { app, get, calls, settle }
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

afterEach(() => {
  delete g.useApi
})

describe('US-005 AC-1..AC-5: pages/threads/index.vue', () => {
  test('AC-1: mounting the page reads GET /threads with status ACTIVE', async () => {
    const m = mountPage()
    await m.settle()

    expect(m.get).toHaveBeenCalledWith('/threads', { query: { status: 'ACTIVE', size: '100' } })
    expect(m.calls[0]?.path).toBe('/threads')
    m.app.unmount()
  })

  test('AC-2: each listed thread renders a row link to /threads/<id>', async () => {
    const m = mountPage({ items: [workspaceItem({ id: 'th1' }), workspaceItem({ id: 'th2', title: 'Second' })] })
    await m.settle()

    expect(linkTo(m.app, '/threads/th1')).toBeDefined()
    expect(linkTo(m.app, '/threads/th2')).toBeDefined()
    m.app.unmount()
  })

  test('AC-3: a WORKSPACE row shows its home project name in the feature column', async () => {
    const m = mountPage({ items: [workspaceItem({ homeProject: { slug: 'web', name: 'Sandbox' } })] })
    await m.settle()

    expect(m.app.text()).toContain('Sandbox')
    expect(m.app.text()).not.toContain('feat/')
    m.app.unmount()
  })

  test('AC-4: switching to archived reloads GET /threads with status ARCHIVED', async () => {
    const m = mountPage()
    await m.settle()

    clickByLabel(m.app, 'fleet.threads.list.archived')
    await m.settle()

    expect(m.calls.map(call => call.query?.status)).toEqual(['ACTIVE', 'ARCHIVED'])
    m.app.unmount()
  })

  test('AC-5: threadsEnabled false renders no link to /threads/new', async () => {
    const m = mountPage({ threadsEnabled: false })
    await m.settle()

    expect(linkTo(m.app, '/threads/new')).toBeUndefined()
    m.app.unmount()
  })

  test('AC-5 (control): threadsEnabled true renders the link to /threads/new', async () => {
    const m = mountPage({ threadsEnabled: true })
    await m.settle()

    expect(linkTo(m.app, '/threads/new')).toBeDefined()
    m.app.unmount()
  })

  test('B2: a full first page offers Load more, which appends the next page', async () => {
    const firstPage = Array.from({ length: 100 }, (_, index) => workspaceItem({ id: `th${index}`, title: `Thread ${index}` }))
    const m = mountPage({ items: firstPage, moreItems: [workspaceItem({ id: 'older', title: 'Older thread' })] })
    await m.settle()

    // Only a full page hints at rows behind it.
    expect(m.app.one('[data-testid="threads-load-more"]')).toBeDefined()

    clickByLabel(m.app, 'fleet.threads.list.loadMore')
    await m.settle()

    expect(m.calls.map(call => call.query)).toEqual([
      { status: 'ACTIVE', size: '100' },
      { status: 'ACTIVE', size: '100', page: '2' },
    ])
    expect(linkTo(m.app, '/threads/older')).toBeDefined()
    // Page 2 came back short, so the control goes away.
    expect(m.app.one('[data-testid="threads-load-more"]')).toBeUndefined()
    m.app.unmount()
  })

  test('B2 (edge): a short first page shows no Load more control', async () => {
    const m = mountPage({ items: [workspaceItem()] })
    await m.settle()

    expect(m.app.one('[data-testid="threads-load-more"]')).toBeUndefined()
    expect(m.calls.map(call => call.query)).toEqual([{ status: 'ACTIVE', size: '100' }])
    m.app.unmount()
  })
})
