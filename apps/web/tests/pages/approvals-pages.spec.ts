import { afterEach, describe, expect, jest, test } from '@jest/globals'
import * as Vue from 'vue'
import { ref, computed } from 'vue'
import { loadSfc, mountSfc, webFile } from '../helpers/mount-sfc'
import { enI18n, toastRecorder, uiStubs } from '../helpers/fleet-harness'
import * as apiModule from '../../composables/useApi'
import * as fleetReposModule from '../../composables/useFleetRepos'
import * as adminUsersModule from '../../composables/useAdminUsers'
import * as memberNamesModule from '../../composables/useProjectMemberNames'
import type { ApprovalRequestSummary } from '../../lib/approval-requests'
import type { ProjectEventHandlers } from '../../lib/project-event-stream'

const { ApiError } = apiModule

const globalPage = webFile('pages', 'approvals.vue')
const projectPage = webFile('pages', '[project]', 'approvals.vue')
const inboxFile = webFile('components', 'approvals', 'ApprovalRequestInbox.vue')

const T = enI18n()

const row = (id: string, over: Partial<ApprovalRequestSummary> = {}): ApprovalRequestSummary => ({
  id,
  permissionKey: 'fleet.budget.override',
  projectId: 'p1',
  actorType: 'USER',
  actorId: 'u1',
  onBehalfOfType: null,
  onBehalfOfId: null,
  origin: 'fleet',
  redeem: false,
  requiredMode: 'human',
  status: 'pending',
  satisfiedBy: null,
  approverType: null,
  approverId: null,
  expiresAt: '2026-11-01T00:10:00.000Z',
  decidedAt: null,
  settledAt: null,
  createdAt: '2026-10-31T23:59:00.000Z',
  ...over,
})

const pageOf = (records: ApprovalRequestSummary[], over: Record<string, unknown> = {}) => ({
  total: records.length,
  current: 1,
  size: 100,
  hasNext: false,
  hasPrev: false,
  records,
  ...over,
})

const usersPage = (records: Array<{ id: string; name: string | null; email: string }>) => ({
  records: records.map((user) => ({ ...user, disabled: false, createdAt: '2026-10-01T00:00:00.000Z' })),
  total: records.length,
  current: 1,
  size: 20,
  hasNext: false,
  hasPrev: false,
})

afterEach(() => {
  delete (globalThis as Record<string, unknown>).useApi
  jest.restoreAllMocks()
})

interface FakeEndpoints {
  /** `GET /approvals` and `GET /approvals/:id`; every other path answers `undefined` unless overridden. */
  approvals?: jest.Mock
  project?: jest.Mock
  projects?: jest.Mock
  users?: jest.Mock
  members?: jest.Mock
}

/**
 * The page's HTTP seams. The lookups (`useFleetRepos`, `useAdminUsers`, `useProjectMemberNames`) are the
 * real composables over this one `$api`, so a spec drives endpoints, not stub state.
 */
function fakeApi(endpoints: FakeEndpoints) {
  const approvals = endpoints.approvals ?? jest.fn(async () => pageOf([]))
  const project = endpoints.project ?? jest.fn(async () => ({ id: 'p1', slug: 'sandbox', name: 'Sandbox' }))
  const projects = endpoints.projects ?? jest.fn(async () => [])
  const users = endpoints.users ?? jest.fn(async () => usersPage([]))
  const members = endpoints.members ?? jest.fn(async () => ({ records: [] }))
  const get = jest.fn(async (path: string, options?: unknown) => {
    if (path === '/approvals') return approvals(path, options)
    if (path.startsWith('/approvals/')) return approvals(path, options)
    if (path === '/projects') return projects(path, options)
    if (path === '/admin/users') return users(path, options)
    if (path.startsWith('/projects/') && path.endsWith('/members')) return members(path, options)
    if (path.startsWith('/projects/')) return project(path, options)
    throw new Error(`unexpected GET ${path}`)
  })
  return { get, post: jest.fn() }
}

const settle = async (): Promise<void> => {
  for (let i = 0; i < 8; i += 1) {
    await new Promise((resolve) => { setImmediate(resolve) })
    await Vue.nextTick()
  }
}

function mountPage(file: string, options: { api: { get: jest.Mock; post: jest.Mock }; params?: Record<string, string> }) {
  // The real lookups call the auto-imported useApi, which a plain jest module reads off the global.
  const globalScope = globalThis as Record<string, unknown>
  globalScope.useApi = () => ({ $api: options.api })
  const toast = toastRecorder()
  const globals: Record<string, unknown> = {
    ref, computed,
    onMounted: Vue.onMounted,
    onBeforeUnmount: Vue.onBeforeUnmount,
    definePageMeta: () => undefined,
    useI18n: () => enI18n(),
    useAppToast: () => toast,
    useApi: () => ({ $api: options.api }),
    useRoute: () => ({ params: options.params ?? {}, query: {} }),
    useRouter: () => ({ replace: jest.fn() }),
    useVisiblePolling: (task: () => Promise<void>) => ({ start: jest.fn(), stop: jest.fn(), runNow: async () => { await task() }, isActive: () => true }),
    useProjectEvents: (_slug: string, _handlers: ProjectEventHandlers) => undefined,
    useFleetRepos: fleetReposModule.useFleetRepos,
    useAdminUsers: adminUsersModule.useAdminUsers,
    useProjectMemberNames: memberNamesModule.useProjectMemberNames,
  }
  const alias = {
    '~/composables/useApi': apiModule,
    '~/composables/useApprovalCountdown': { useApprovalCountdown: () => ({ now: ref(new Date('2026-11-01T00:00:00.000Z')) }) },
  }
  // The real inbox: the pages are tested as they render, not against a stub that mirrors their props.
  const inbox = loadSfc(inboxFile, globals, alias)
  const app = mountSfc(file, {
    components: { ...uiStubs, ApprovalsApprovalRequestInbox: inbox },
    globals,
    alias,
  })
  return { app, toast }
}

describe('pages/approvals.vue — the global inbox', () => {
  test('AC-1: the page lists pending requests, one page of 100', async () => {
    const api = fakeApi({})
    const m = mountPage(globalPage, { api })
    await settle()
    expect(api.get).toHaveBeenCalledWith('/approvals', { query: { status: 'pending', size: '100' } })
    m.app.unmount()
  })

  test('AC-5: a user requester is named from useAdminUsers', async () => {
    const api = fakeApi({
      approvals: jest.fn(async () => pageOf([row('r1', { actorId: 'u1' })])),
      users: jest.fn(async () => usersPage([{ id: 'u1', name: 'Ann', email: 'ann@koda.test' }])),
    })
    const m = mountPage(globalPage, { api })
    await settle()
    const requester = m.app.one('[data-testid="approval-request-requester"]')
    expect(requester === undefined ? null : m.app.textOf(requester)).toBe('Ann')
    m.app.unmount()
  })

  test('AC-5 (edge): a user the lookup cannot name shows their id', async () => {
    const api = fakeApi({
      approvals: jest.fn(async () => pageOf([row('r1', { actorId: 'u7' })])),
      users: jest.fn(async () => usersPage([])),
    })
    const m = mountPage(globalPage, { api })
    await settle()
    const requester = m.app.one('[data-testid="approval-request-requester"]')
    expect(requester === undefined ? null : m.app.textOf(requester)).toBe('u7')
    m.app.unmount()
  })

  test('AC-6: a row\'s project shows the slug GET /projects resolves', async () => {
    const api = fakeApi({
      approvals: jest.fn(async () => pageOf([row('r1', { projectId: 'p1' })])),
      projects: jest.fn(async () => [{ id: 'p1', slug: 'sandbox', name: 'Sandbox' }]),
    })
    const m = mountPage(globalPage, { api })
    await settle()
    expect(api.get).toHaveBeenCalledWith('/projects')
    const project = m.app.one('[data-testid="approval-request-project"]')
    expect(project === undefined ? null : m.app.textOf(project)).toBe('sandbox')
    m.app.unmount()
  })

  test('AC-6 (edge): a project the lookup misses shows its id, and no project shows the no-project copy', async () => {
    const api = fakeApi({
      approvals: jest.fn(async () => pageOf([row('r1', { id: 'r1', projectId: 'gone' }), row('r2', { projectId: null })])),
      projects: jest.fn(async () => [{ id: 'p1', slug: 'sandbox', name: 'Sandbox' }]),
    })
    const m = mountPage(globalPage, { api })
    await settle()
    const projects = m.app.find('[data-testid="approval-request-project"]').map((n) => m.app.textOf(n))
    expect(projects).toEqual(['gone', T.t('approvals.inbox.noProject')])
    m.app.unmount()
  })

  test('a failed lookup leaves the inbox working: the titles still render', async () => {
    const api = fakeApi({
      approvals: jest.fn(async () => pageOf([row('r1')])),
      projects: jest.fn(async () => { throw new ApiError(500, 'boom') }),
      users: jest.fn(async () => { throw new ApiError(500, 'boom') }),
    })
    const m = mountPage(globalPage, { api })
    await settle()
    expect(m.app.one('[data-stub="page-header"]')?.props.title).toBe(T.t('approvals.inbox.title'))
    expect(m.app.find('[data-testid="approval-request-row-r1"]')).toHaveLength(1)
    expect(m.toast.errors).toEqual([])
    m.app.unmount()
  })
})

describe('pages/[project]/approvals.vue — the project inbox', () => {
  test('AC-2: the page lists the project\'s requests by project id', async () => {
    const api = fakeApi({ project: jest.fn(async () => ({ id: 'p1' })) })
    const m = mountPage(projectPage, { api, params: { project: 'sandbox' } })
    await settle()
    expect(api.get).toHaveBeenCalledWith('/projects/sandbox')
    expect(api.get).toHaveBeenCalledWith('/approvals', { query: { status: 'pending', projectId: 'p1', size: '100' } })
    m.app.unmount()
  })

  test('the project inbox names user requesters from the project members', async () => {
    const api = fakeApi({
      project: jest.fn(async () => ({ id: 'p1' })),
      approvals: jest.fn(async () => pageOf([row('r1', { actorId: 'u2' })])),
      members: jest.fn(async () => ({ records: [{ userId: 'u2', name: 'Bo', email: 'bo@koda.test' }] })),
    })
    const m = mountPage(projectPage, { api, params: { project: 'sandbox' } })
    await settle()
    const requester = m.app.one('[data-testid="approval-request-requester"]')
    expect(requester === undefined ? null : m.app.textOf(requester)).toBe('Bo')
    const project = m.app.one('[data-testid="approval-request-project"]')
    expect(project === undefined ? null : m.app.textOf(project)).toBe('sandbox')
    m.app.unmount()
  })

  test('AC-15: a project slug that does not resolve lists nothing and toasts the refusal', async () => {
    const api = fakeApi({ project: jest.fn(async () => { throw new ApiError(40004, 'Project not found') }) })
    const m = mountPage(projectPage, { api, params: { project: 'sandbox' } })
    await settle()
    expect(api.get).toHaveBeenCalledWith('/projects/sandbox')
    expect(api.get.mock.calls.filter(([path]) => path === '/approvals')).toHaveLength(0)
    expect(m.toast.errors).toEqual(['Project not found'])
    m.app.unmount()
  })
})
