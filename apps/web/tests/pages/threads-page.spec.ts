import { describe, expect, jest, test } from '@jest/globals'
import * as Vue from 'vue'
import { ref, computed, watch, nextTick } from 'vue'
import { mountSfc, webFile, loadSfc } from '../helpers/mount-sfc'
import type { FakeNode, Mounted } from '../helpers/mount-sfc'
import { uiStubs, i18nStub, toastRecorder } from '../helpers/fleet-harness'
import * as apiModule from '../../composables/useApi'
import type { ThreadDto } from '~/lib/thread-types'

const pageFile = webFile('pages', '[project]', 'threads.vue')

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
 * The page under test is `pages/[project]/threads.vue` (US-004). It auto-imports useThreads,
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
} = {}) {
  const load = over.load ?? jest.fn<() => Promise<void>>(async () => undefined)
  const app = mountSfc(pageFile, {
    components: {
      ...uiStubs,
      ThreadListTable: loadSfc(webFile('components', 'ThreadListTable.vue'), { useI18n: () => i18nStub() }),
    },
    alias: { '~/composables/useApi': apiModule },
    globals: {
      ref, computed, watch, nextTick,
      onMounted: Vue.onMounted,
      definePageMeta: () => undefined,
      useI18n: () => i18nStub(),
      useAppToast: () => toastRecorder(),
      useApi: () => ({ $api: { get: jest.fn(async () => ({})) } }),
      useRoute: () => ({ params: { project: 'web' } }),
      useAuth: () => ({ user: ref({ id: 'me', email: 'a@k.t', role: 'MEMBER' }) }),
      useProjectViewerRole: () => ({ data: ref(over.role ?? VIEWER) }),
      useProjectMemberNames: () => ({ load: jest.fn(async () => undefined), nameOf: () => 'Dana' }),
      useThreads: () => ({
        threads: ref(over.threads ?? [listItem()]),
        threadsEnabled: ref(over.threadsEnabled ?? true),
        status: ref<'ACTIVE' | 'ARCHIVED'>('ACTIVE'),
        load,
      }),
    },
  })
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 6; i += 1) {
      await new Promise((resolve) => { setImmediate(resolve) })
      await Vue.nextTick()
    }
  }
  return { app, load, settle }
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