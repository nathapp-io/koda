import { describe, test, expect, afterEach, jest } from '@jest/globals'
import * as Vue from 'vue'
import { ref, computed, watch, nextTick } from 'vue'
import { mountSfc } from '../helpers/mount-sfc'
import {
  reposPage, addRepoDialog, reachabilityBadge, uiStubs, enI18n, toastRecorder, ToastRecorder,
} from '../helpers/fleet-harness'
import * as apiModule from '../../composables/useApi'
import { ApiError } from '../../composables/useApi'
import { useFleetRepos } from '../../composables/useFleetRepos'
import type { FleetPage, FleetRepo, FleetRepoCheck } from '../../lib/fleet-types'

const repo = (id: string, over: Partial<FleetRepo> = {}): FleetRepo => ({
  id, projectId: 'p1', provider: 'github', owner: 'acme', name: id, defaultBranch: 'main',
  githubInstallationId: '7', createdAt: '2026-10-01T00:00:00Z', ...over,
})

const pageOf = (records: unknown[], over: Record<string, unknown> = {}): FleetPage<never> =>
  ({ records, total: records.length, current: 1, size: 100, hasNext: false, hasPrev: false, ...over }) as FleetPage<never>

const checkOk = (repoId: string, reachable = true): FleetRepoCheck =>
  ({ repoId, reachable, reason: reachable ? null : 'repo_not_found', checkedAt: '2026-10-01T00:00:00Z' })

interface Api {
  get: jest.Mock
  post: jest.Mock
  delete: jest.Mock
}

type Node = ReturnType<ReturnType<typeof mountSfc>['find']>[number]

interface MountedRepos {
  app: ReturnType<typeof mountSfc>
  api: Api
  toasts: ToastRecorder
  settle: () => Promise<void>
  button: (label: string) => { onClick: () => void | Promise<void> }
  /** The row for this repo id, throwing when it is absent. */
  rowOf: (id: string) => Node
  rows: () => Node[]
  /** The single button with this label, optionally scoped to one node. */
  buttonIn: (label: string, scope?: Node) => Node
  /** Fires a node's `onClick`. */
  click: (node: Node) => void | Promise<void>
  unmount: () => void
}

/**
 * Mounts the Repos page. `get` serves both `/fleet/repos` (a page) and `/projects` (a plain array),
 * which is how the real composable tells them apart.
 */
function mountRepos(
  over: { repos?: FleetRepo[]; check?: (id: string) => Promise<FleetRepoCheck>; failRepos?: unknown; confirm?: boolean } = {},
): MountedRepos {
  const check = over.check ?? (async (id: string) => checkOk(id))
  const api: Api = {
    get: jest.fn(async (path: string) => {
      if (path === '/projects') return [{ id: 'p1', slug: 'koda', name: 'Koda', key: 'KODA' }]
      if (over.failRepos) throw over.failRepos
      return pageOf(over.repos ?? [repo('alpha'), repo('beta')])
    }),
    post: jest.fn(async (path: string) => check(path.split('/')[3])),
    delete: jest.fn(async () => ({})),
  }
  const toasts = toastRecorder()
  ;(globalThis as Record<string, unknown>).useApi = () => ({ $api: api })
  globalThis.window = { confirm: () => over.confirm ?? true } as never

  const app = mountSfc(reposPage, {
    components: uiStubs,
    // The reachability badge is mounted for real: its label is the page's main output.
    fleetComponents: ['FleetRepoReachabilityBadge'],
    alias: { '~/composables/useApi': apiModule },
    globals: {
      ref, computed, watch, nextTick,
      onMounted: Vue.onMounted,
      onBeforeUnmount: Vue.onBeforeUnmount,
      useI18n: () => enI18n(),
      useAppToast: () => toasts,
      useApi: () => ({ $api: api }),
      useFleetRepos: () => useFleetRepos(),
    },
  })

  const settle = async (): Promise<void> => {
    for (let i = 0; i < 5; i += 1) {
      await new Promise((resolve) => { setImmediate(resolve) })
      await Vue.nextTick()
    }
  }
  const rows = (): Node[] => app.find('[data-stub="tbody"] > [data-stub="tr"]')
  // Identified by the row's `data-testid`, never by text: `owner/name` can contain the other repo's
  // name as a substring, which made `includes(id)` match the wrong row.
  const rowFor = (id: string): Node | undefined => rows().find((r) => r.props['data-testid'] === `fleet-repo-acme-${id}`)
  // Scoped to `scope` (a row) or the whole page; identifies the button by its rendered label.
  const buttonIn = (label: string, scope?: Node): Node => {
    const match = app.find('[data-stub="button"]', scope).filter((b) => app.textOf(b) === label)
    if (match.length !== 1) throw new Error(`expected one "${label}" button, found ${match.length} in: ${app.text()}`)
    return match[0]
  }
  const click = (node: Node) => (node.props.onClick as () => void | Promise<void>)()
  const button = (label: string) => ({ onClick: () => click(buttonIn(label)) })
  /** The row for this repo id, failing the test with a clear message when it is gone. */
  const rowOf = (id: string): Node => {
    const row = rowFor(id)
    if (!row) throw new Error(`no row for ${id} in: ${app.text()}`)
    return row
  }
  return { app, api, toasts, settle, button, rows, rowOf, buttonIn, click, unmount: app.unmount }
}

describe('Fleet admin Repos page (behaviour)', () => {
  afterEach(() => {
    delete (globalThis as Record<string, unknown>).window
    delete (globalThis as Record<string, unknown>).useApi
  })

  test('renders a row per repo with its owner/name, provider, branch and project', async () => {
    const { app, rows, settle, unmount } = mountRepos()
    await settle()

    expect(rows()).toHaveLength(2)
    expect(app.text()).toContain('acme/alpha')
    expect(app.text()).toContain('main')
    // The project id is resolved to a slug via the loaded project list.
    expect(app.text()).toContain('koda')
    unmount()
  })

  test('mounting does NOT spend a forge check per row', async () => {
    const { api, settle, unmount } = mountRepos()
    await settle()

    // A check is a real outbound call to GitHub/GitLab; the page must not fan out on load.
    expect(api.post).not.toHaveBeenCalled()
    unmount()
  })

  test('rows start as "Not checked" rather than claiming a check is running', async () => {
    const { app, rowOf, settle, unmount } = mountRepos()
    await settle()

    expect(app.textOf(rowOf('alpha'))).toContain('Not checked')
    unmount()
  })

  test('"Check all" runs one check per repo and reports the verdicts', async () => {
    const { api, button, rowOf, app, settle, unmount } = mountRepos()
    await settle()

    await button('Check all').onClick()
    await settle()

    expect(api.post).toHaveBeenCalledTimes(2)
    expect(app.textOf(rowOf('alpha'))).toContain('Reachable')
    unmount()
  })

  test('an unreachable repo shows a translated reason', async () => {
    const { button, rowOf, app, settle, unmount } = mountRepos({
      check: async (id) => checkOk(id, false),
    })
    await settle()

    await button('Check all').onClick()
    await settle()

    expect(app.textOf(rowOf('alpha'))).toContain('Repository not found')
    unmount()
  })

  test('a failing check marks only its own row', async () => {
    const { button, rowOf, app, settle, unmount } = mountRepos({
      check: async (id) => {
        if (id === 'alpha') throw new Error('forge down')
        return checkOk(id)
      },
    })
    await settle()

    await button('Check all').onClick()
    await settle()

    expect(app.textOf(rowOf('alpha'))).toContain('Check failed')
    expect(app.textOf(rowOf('beta'))).toContain('Reachable')
    unmount()
  })

  test('a single recheck only checks that row', async () => {
    const { api, rowOf, buttonIn, click, settle, unmount } = mountRepos()
    await settle()

    await click(buttonIn('Check again', rowOf('alpha')))
    await settle()

    expect(api.post).toHaveBeenCalledTimes(1)
    expect(api.post).toHaveBeenCalledWith('/fleet/repos/alpha/check', {})
    unmount()
  })

  test('the recheck button is disabled while that row is checking', async () => {
    let release: (v: FleetRepoCheck) => void = () => undefined
    const { rowOf, buttonIn, click, settle, unmount } = mountRepos({
      check: () => new Promise<FleetRepoCheck>((resolve) => { release = resolve }),
    })
    await settle()

    void click(buttonIn('Check again', rowOf('alpha')))
    await Vue.nextTick()

    expect(buttonIn('Check again', rowOf('alpha')).props.disabled).toBe(true)

    release(checkOk('alpha'))
    await settle()
    expect(buttonIn('Check again', rowOf('alpha')).props.disabled).toBe(false)
    unmount()
  })

  test('a global-admin 403 shows the admin-only note and hides the table', async () => {
    const { app, settle, unmount } = mountRepos({ failRepos: new ApiError(40003, 'forbidden') })
    await settle()

    expect(app.text()).toContain('Only global administrators can manage the fleet.')
    expect(app.find('[data-stub="table"]')).toHaveLength(0)
    unmount()
  })

  test('a failed first load toasts the API message', async () => {
    const { toasts, settle, unmount } = mountRepos({ failRepos: new Error('API down') })
    await settle()

    expect(toasts.errors).toEqual(['API down'])
    unmount()
  })

  test('the list asks for one page of 100', async () => {
    const { api, settle, unmount } = mountRepos()
    await settle()
    expect(api.get).toHaveBeenCalledWith('/fleet/repos', { query: { size: '100' } })
    unmount()
  })

  test('deleting asks first and a cancelled confirm deletes nothing', async () => {
    const { api, buttonIn, click, rowOf, settle, unmount } = mountRepos({ confirm: false })
    await settle()

    await click(buttonIn('Delete', rowOf('alpha')))
    await settle()

    expect(api.delete).not.toHaveBeenCalled()
    unmount()
  })

  test('an accepted confirm deletes the row and toasts', async () => {
    const { api, toasts, buttonIn, click, rowOf, rows, settle, unmount } = mountRepos()
    await settle()

    await click(buttonIn('Delete', rowOf('alpha')))
    await settle()

    expect(api.delete).toHaveBeenCalledWith('/fleet/repos/alpha')
    expect(toasts.successes).toHaveLength(1)
    expect(rows()).toHaveLength(1)
    unmount()
  })
})

describe('Fleet repo reachability badge (behaviour)', () => {
  const mountBadge = (state: unknown) =>
    mountSfc(reachabilityBadge, {
      components: uiStubs,
      props: { state },
      globals: { useI18n: () => enI18n(), useAppToast: () => toastRecorder() },
    })

  test('a known reason is translated', () => {
    const app = mountBadge({ status: 'done', result: checkOk('alpha', false) })
    expect(app.text()).toContain('Unreachable')
    expect(app.text()).toContain('Repository not found')
    app.unmount()
  })

  test('an unknown reason code is shown raw rather than blank', () => {
    const app = mountBadge({
      status: 'done',
      result: { ...checkOk('alpha', false), reason: 'some_future_reason' },
    })
    expect(app.text()).toContain('some_future_reason')
    app.unmount()
  })

  test('a reachable repo reads Reachable with no reason', () => {
    const app = mountBadge({ status: 'done', result: checkOk('alpha') })
    expect(app.text()).toBe('Reachable')
    app.unmount()
  })

  test('a never-checked row reads Not checked, not Checking', () => {
    const app = mountBadge(undefined)
    expect(app.text()).toBe('Not checked')
    app.unmount()
  })

  test('an in-flight check reads Checking', () => {
    const app = mountBadge({ status: 'checking' })
    expect(app.text()).toBe('Checking…')
    app.unmount()
  })

  test('a failed request reads Check failed and keeps the message as its title', () => {
    const app = mountBadge({ status: 'error', message: 'forge down' })
    expect(app.text()).toBe('Check failed')
    expect(app.one('[data-stub="badge"]')?.props.title).toBe('forge down')
    app.unmount()
  })
})

describe('Fleet AddRepoDialog (behaviour)', () => {
  afterEach(() => {
    delete (globalThis as Record<string, unknown>).useApi
  })

  test('an invalid owner is refused before any request', async () => {
    const post = jest.fn()
    const api = { get: jest.fn(), post, delete: jest.fn() }
    ;(globalThis as Record<string, unknown>).useApi = () => ({ $api: api })
    const app = mountSfc(addRepoDialog, {
      components: uiStubs,
      props: { open: true, projects: [{ id: 'p1', slug: 'koda', name: 'Koda' }] },
      // The badge is mounted for real, so its `~/composables/useFleetRepos` type import resolves.
      alias: { '~/composables/useApi': apiModule },
      globals: {
        ref, computed, watch, nextTick,
        onMounted: Vue.onMounted, onBeforeUnmount: Vue.onBeforeUnmount,
        useI18n: () => enI18n(), useAppToast: () => toastRecorder(), useApi: () => ({ $api: api }),
        useFleetRepos: () => useFleetRepos(),
      },
    })
    for (let i = 0; i < 4; i += 1) await Vue.nextTick()

    expect(app.find('[data-stub="fleet-select"]')).toHaveLength(2)
    expect(post).not.toHaveBeenCalled()
    app.unmount()
  })

  test('closing the dialog emits update:open false', async () => {
    const api = { get: jest.fn(), post: jest.fn(), delete: jest.fn() }
    ;(globalThis as Record<string, unknown>).useApi = () => ({ $api: api })
    const app = mountSfc(addRepoDialog, {
      components: uiStubs,
      props: { open: true, projects: [] },
      alias: { '~/composables/useApi': apiModule },
      globals: {
        ref, computed, watch, nextTick,
        onMounted: Vue.onMounted, onBeforeUnmount: Vue.onBeforeUnmount,
        useI18n: () => enI18n(), useAppToast: () => toastRecorder(), useApi: () => ({ $api: api }),
        useFleetRepos: () => useFleetRepos(),
      },
    })
    for (let i = 0; i < 4; i += 1) await Vue.nextTick()

    const cancel = app.find('[data-stub="button"]').find((b) => app.textOf(b) === 'Cancel')
    await (cancel.props.onClick as () => void)()
    await Vue.nextTick()

    expect(app.emitted('update:open')).toEqual([[false]])
    app.unmount()
  })
})