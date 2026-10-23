import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals'
import * as Vue from 'vue'
import { computed, defineComponent, h, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { loadSfc, mountSfc, webFile } from '../helpers/mount-sfc'
import type { FakeNode, Mounted } from '../helpers/mount-sfc'
import { enI18n, toastRecorder, uiStubs } from '../helpers/fleet-harness'
import { useGlobalPermissions, useProjectPermissions } from '~/composables/usePermissions'
import { fakeAsyncData, resetAsyncCalls } from '../helpers/permission-nav'

/**
 * Permissions P1 US-007: the project gates (the ticket, label, thread, skills, knowledge and
 * project-agents rows of the gate table).
 *
 * Every AC mounts the real page or component with the REAL `useProjectPermissions` /
 * `useGlobalPermissions` composable: the only thing the test supplies is `$api.get('/me/permissions')`,
 * which answers the key list for the scope being asked for. So a gate that still read a role boolean
 * would fail here, and the permission plumbing (fetch, fail-closed default, key lookup) is exercised
 * end to end instead of being mocked into the component.
 */

const g = globalThis as Record<string, unknown>

// ─────────────────────────────────────────────────────────────────────────────
// shared harness
// ─────────────────────────────────────────────────────────────────────────────

/** i18n with the real English copy, plus the `locale` ref the ticket components format dates with. */
function pageI18n(): Record<string, unknown> {
  return { ...enI18n(), locale: ref('en') }
}

interface RouteAnswer {
  /** The project-scope keys `/me/permissions?project=<slug>` answers. */
  project?: readonly string[]
  /** The global-scope keys `/me/permissions` answers. */
  global?: readonly string[]
  /** Any other GET the mounted surface makes, by path. */
  routes?: Record<string, unknown>
  /** A path whose GET never settles: the page is left with the fail-closed permission set. */
  hang?: readonly string[]
}

/**
 * A `$api.get` that answers the permissions endpoint from the given key lists and every other path
 * from `routes`. `/me/permissions` without a query is the global scope; with `?project=` it is that
 * project's scope, exactly as the API answers (US-001).
 */
function permissionsApi(answer: RouteAnswer): jest.Mock {
  return jest.fn(async (path: string, options?: { query?: Record<string, string> }) => {
    if (answer.hang?.includes(path)) return new Promise(() => undefined)
    if (path === '/me/permissions') {
      const project = options?.query?.project
      return project === undefined
        ? { scope: 'global', projectSlug: null, keys: [...(answer.global ?? [])] }
        : { scope: 'project', projectSlug: project, keys: [...(answer.project ?? [])] }
    }
    if (answer.routes && path in answer.routes) return answer.routes[path]
    return {}
  })
}

/** Installs the two Nuxt auto-imports the real permissions composable resolves at runtime. */
function installPermissionsRuntime(get: jest.Mock): void {
  g.useAsyncData = fakeAsyncData
  g.useApi = () => ({ $api: { get } })
}

/** Drains the fetch microtasks plus the Vue scheduler. */
async function settle(): Promise<void> {
  for (let i = 0; i < 6; i += 1) {
    await new Promise((resolve) => { setImmediate(resolve) })
    await Vue.nextTick()
  }
}

/** The first stub-button whose own text is exactly `label`. */
function buttonByText(app: Mounted, label: string): FakeNode | undefined {
  return app.find('[data-stub="button"]').find((button) => app.textOf(button) === label)
}

const byTestId = (app: Mounted, testId: string): FakeNode | undefined =>
  app.find(`[data-testid="${testId}"]`)[0]

/** A component the spec does not assert on: it renders nothing, so it cannot influence an assertion. */
function inert(name: string): ReturnType<typeof defineComponent> {
  return defineComponent({ name, setup: () => () => null })
}

// The ticket page binds its keyboard shortcuts on mount; node has no window, so the listeners land
// on this double instead of throwing out of the mounted hook.
const windowStub = { addEventListener: jest.fn(), removeEventListener: jest.fn() }

beforeEach(() => {
  g.window = windowStub
})

afterEach(() => {
  delete g.useAsyncData
  delete g.useApi
  delete g.window
  resetAsyncCalls()
})

// ─────────────────────────────────────────────────────────────────────────────
// AC-1 … AC-5 — pages/[project]/tickets/[ref].vue → TicketProperties
// ─────────────────────────────────────────────────────────────────────────────

interface TicketOver {
  project?: readonly string[]
  fleetRepo?: boolean
  ticket?: Record<string, unknown>
}

const ticketFixture = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 't1',
  ref: 'WEB-1',
  title: 'Fix login',
  type: 'BUG',
  priority: 'HIGH',
  status: 'CREATED',
  createdAt: '2026-10-01T00:00:00.000Z',
  assignee: null,
  labels: [],
  links: [],
  ...over,
})

/** Records the `canWork` prop the ticket page hands the Fleet runs card. */
const FleetRunsRecorder = defineComponent({
  name: 'StubTicketFleetRuns',
  props: { canWork: { type: Boolean, default: false } },
  setup(props) {
    return () => h('x-stub-stub', { 'data-testid': 'ticket-fleet-runs', 'data-can-work': props.canWork === true ? 'true' : 'false' })
  },
})

interface TicketPage {
  app: Mounted
  get: jest.Mock
  del: jest.Mock
}

function mountTicketPage(over: TicketOver = {}): TicketPage {
  const ticket = ticketFixture(over.ticket)
  const get = permissionsApi({
    project: over.project ?? [],
    routes: {
      [`/projects/web/tickets/${String(ticket.ref)}`]: ticket,
      [`/projects/web/tickets/${String(ticket.ref)}/links`]: ticket.links,
      '/projects/web/labels': [],
      '/projects/web/fleet/repos': { records: over.fleetRepo === true ? [{ id: 'r1', owner: 'acme', name: 'app' }] : [] },
      '/projects/web/assignees': { items: [] },
    },
  })
  installPermissionsRuntime(get)

  const $api = { get, post: jest.fn(async () => ({})), delete: jest.fn(async () => ({})), patch: jest.fn(async () => ({})) }
  const del = $api.delete as unknown as jest.Mock
  const globals = {
    ref, computed, watch, nextTick, onMounted, onBeforeUnmount,
    useI18n: () => pageI18n(),
    useAppToast: () => toastRecorder(),
    useApi: () => ({ $api }),
    useAsyncData: fakeAsyncData,
    useNuxtData: () => ({ data: ref(null) }),
    useProjectEvents: () => undefined,
    useProjectPermissions,
    useRoute: () => ({ params: { project: 'web', ref: ticket.ref } }),
    navigateTo: jest.fn(async () => undefined),
  }
  const propertyStubs = {
    ...uiStubs,
    Select: uiStubs.Button, SelectTrigger: uiStubs.Button, SelectValue: uiStubs.Button,
    SelectContent: uiStubs.Button, SelectItem: uiStubs.Button,
  }
  const properties = loadSfc(
    webFile('components', 'TicketProperties.vue'),
    globals,
    { '~/components/TicketActionPanel.vue': { __esModule: true, default: inert('StubTicketActionPanel') } },
  )
  const header = loadSfc(webFile('components', 'TicketHeader.vue'), globals)

  const app = mountSfc(webFile('pages', '[project]', 'tickets', '[ref].vue'), {
    components: { ...propertyStubs },
    globals,
    alias: {
      '~/components/TicketHeader.vue': { __esModule: true, default: header },
      '~/components/TicketProperties.vue': { __esModule: true, default: properties },
      '~/components/TicketFleetRuns.vue': { __esModule: true, default: FleetRunsRecorder },
      '~/components/TicketActivity.vue': { __esModule: true, default: inert('StubTicketActivity') },
      '~/components/TicketWatchButton.vue': { __esModule: true, default: inert('StubTicketWatchButton') },
    },
  })
  return { app, get, del }
}

describe('US-007 AC-1: ticket.assign renders the assignee controls alone', () => {
  test('AC-1: only that key renders the assignee picker and no label select, link form or delete button', async () => {
    const { app } = mountTicketPage({ project: ['ticket.assign'] })
    await settle()

    expect(byTestId(app, 'assignee-search')).toBeDefined()
    expect(buttonByText(app, 'Unassign')).toBeDefined()
    expect(buttonByText(app, 'Add Label')).toBeUndefined()
    expect(buttonByText(app, 'Add Link')).toBeUndefined()
    expect(buttonByText(app, 'Delete Ticket')).toBeUndefined()
    app.unmount()
  })

  test('AC-1 (control): no key at all renders no assignee picker either', async () => {
    const { app } = mountTicketPage({ project: [] })
    await settle()

    expect(byTestId(app, 'assignee-search')).toBeUndefined()
    expect(buttonByText(app, 'Unassign')).toBeUndefined()
    app.unmount()
  })
})

describe('US-007 AC-2: the label select and the chip removal are separate keys', () => {
  const labelled = { labels: [{ id: 'l1', name: 'bug', color: '#6366F1' }] }

  test('AC-2: ticket.label.assign alone renders the label select', async () => {
    const { app } = mountTicketPage({ project: ['ticket.label.assign'], ticket: labelled })
    await settle()

    expect(buttonByText(app, 'Add Label')).toBeDefined()
    app.unmount()
  })

  test('AC-2: without ticket.label.remove the chips are not removable', async () => {
    const { app, del } = mountTicketPage({ project: ['ticket.label.assign'], ticket: labelled })
    await settle()

    const chip = app.find('button').find((node) => app.textOf(node) === 'bug')
    expect(chip).toBeDefined()
    expect(chip?.props.disabled).toBe(true)
    expect(chip?.props.onClick).toBeInstanceOf(Function)
    // The click handler is a no-op while the key is missing: nothing is deleted.
    ;(chip?.props.onClick as () => void)()
    await settle()

    expect(del).not.toHaveBeenCalled()
    app.unmount()
  })

  test('AC-2: with ticket.label.remove the chips are removable', async () => {
    const { app } = mountTicketPage({ project: ['ticket.label.remove'], ticket: labelled })
    await settle()

    const chip = app.find('button').find((node) => app.textOf(node) === 'bug')
    expect(chip).toBeDefined()
    expect(chip?.props.disabled).toBe(false)
    app.unmount()
  })
})

describe('US-007 AC-3: the link form and the delete button each follow their own key', () => {
  const linked = {
    links: [{ id: 'k1', ticketId: 't1', url: 'https://example.test/x', provider: 'plain', externalRef: null, createdAt: '2026-10-01T00:00:00.000Z' }],
  }

  test('AC-3: ticket.link.add renders the link form', async () => {
    const { app } = mountTicketPage({ project: ['ticket.link.add'], ticket: linked })
    await settle()

    expect(buttonByText(app, 'Add Link')).toBeDefined()
    expect(buttonByText(app, 'Delete Ticket')).toBeUndefined()
    app.unmount()
  })

  test('AC-3: ticket.link.add renders the link form on a ticket with no links yet', async () => {
    // The first link is the one the holder of ticket.link.add must be able to add: the Linked panel
    // may not be gated on already having a link.
    const { app } = mountTicketPage({ project: ['ticket.link.add'], ticket: { links: [] } })
    await settle()

    expect(app.text()).toContain('Linked')
    expect(buttonByText(app, 'Add Link')).toBeDefined()
    app.unmount()
  })

  test('AC-3: without ticket.link.add an empty Linked section does not render at all', async () => {
    const { app } = mountTicketPage({ project: [], ticket: { links: [] } })
    await settle()

    expect(buttonByText(app, 'Add Link')).toBeUndefined()
    app.unmount()
  })

  test('AC-3: without ticket.link.add the form is gone', async () => {
    const { app } = mountTicketPage({ project: [], ticket: linked })
    await settle()

    expect(buttonByText(app, 'Add Link')).toBeUndefined()
    app.unmount()
  })

  test('AC-3: ticket.delete renders the delete button', async () => {
    const { app } = mountTicketPage({ project: ['ticket.delete'], ticket: linked })
    await settle()

    expect(buttonByText(app, 'Delete Ticket')).toBeDefined()
    expect(buttonByText(app, 'Add Link')).toBeUndefined()
    app.unmount()
  })
})

describe('US-007 AC-4: the Fleet runs unlink control follows fleet.ticket-job.unlink', () => {
  test('AC-4: fleet.ticket-job.unlink passes canWork true to TicketFleetRuns', async () => {
    const { app } = mountTicketPage({ project: ['fleet.ticket-job.unlink'] })
    await settle()

    expect(byTestId(app, 'ticket-fleet-runs')?.props['data-can-work']).toBe('true')
    app.unmount()
  })

  test('AC-4: without that key canWork is false', async () => {
    const { app } = mountTicketPage({ project: ['ticket.assign', 'fleet.job.dispatch'] })
    await settle()

    expect(byTestId(app, 'ticket-fleet-runs')?.props['data-can-work']).toBe('false')
    app.unmount()
  })
})

describe('US-007 AC-5: the fleet dispatch suggestion needs fleet.job.dispatch, a repo and a linkable ticket', () => {
  test('AC-5: all three conditions render the Dispatch link', async () => {
    const { app } = mountTicketPage({ project: ['fleet.job.dispatch'], fleetRepo: true })
    await settle()

    expect(byTestId(app, 'ticket-fleet-dispatch')).toBeDefined()
    app.unmount()
  })

  test('AC-5: without fleet.job.dispatch there is no Dispatch link', async () => {
    const { app } = mountTicketPage({ project: [], fleetRepo: true })
    await settle()

    expect(byTestId(app, 'ticket-fleet-dispatch')).toBeUndefined()
    app.unmount()
  })

  test('AC-5: with the key but no fleet repo there is no Dispatch link', async () => {
    const { app } = mountTicketPage({ project: ['fleet.job.dispatch'], fleetRepo: false })
    await settle()

    expect(byTestId(app, 'ticket-fleet-dispatch')).toBeUndefined()
    app.unmount()
  })

  test('AC-5: with the key and a repo but a closed ticket there is no Dispatch link', async () => {
    const { app } = mountTicketPage({ project: ['fleet.job.dispatch'], fleetRepo: true, ticket: { status: 'CLOSED' } })
    await settle()

    expect(byTestId(app, 'ticket-fleet-dispatch')).toBeUndefined()
    app.unmount()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// AC-6, AC-7 — pages/[project]/labels.vue
// ─────────────────────────────────────────────────────────────────────────────

const LABELS = [
  { id: 'l1', name: 'bug', color: '#6366F1' },
  { id: 'l2', name: 'docs', color: '#22C55E' },
]

function mountLabelsPage(project: readonly string[]): Mounted {
  const get = permissionsApi({ project, routes: { '/projects/web/labels': LABELS } })
  installPermissionsRuntime(get)
  const $api = { get, post: jest.fn(async () => ({})), patch: jest.fn(async () => ({})), delete: jest.fn(async () => ({})) }
  return mountSfc(webFile('pages', '[project]', 'labels.vue'), {
    components: {
      ...uiStubs,
      ColorPicker: inert('StubColorPicker'),
    },
    globals: {
      ref, computed, watch, nextTick, onMounted, onBeforeUnmount,
      useI18n: () => pageI18n(),
      useAppToast: () => toastRecorder(),
      useApi: () => ({ $api }),
      useAsyncData: fakeAsyncData,
      useProjectPermissions,
      useRoute: () => ({ params: { project: 'web' } }),
    },
  })
}

/** Only the row actions (the buttons inside a table row), never the page's own controls. */
function rowActionButtons(app: Mounted, label: string): FakeNode[] {
  return app.find('[data-stub="tr"]')
    .filter((row) => app.textOf(row).includes(label))
    .flatMap((row) => app.find('[data-stub="button"]', row))
}

describe('US-007 AC-6: the label create form follows label.create alone', () => {
  test('AC-6: label.create renders the create form and no row edit or delete button', async () => {
    const app = mountLabelsPage(['label.create'])
    await settle()

    expect(app.text()).toContain('Create Label')
    expect(rowActionButtons(app, 'bug')).toHaveLength(0)
    expect(rowActionButtons(app, 'docs')).toHaveLength(0)
    app.unmount()
  })

  test('AC-6 (control): without label.create the form is gone and the rows still render', async () => {
    const app = mountLabelsPage([])
    await settle()

    expect(app.text()).not.toContain('Create Label')
    expect(app.text()).toContain('bug')
    app.unmount()
  })
})

describe('US-007 AC-7: each label row follows label.update and label.delete', () => {
  test('AC-7: label.update renders every row\'s Edit button and no Delete', async () => {
    const app = mountLabelsPage(['label.update'])
    await settle()

    expect(rowActionButtons(app, 'bug').map((button) => app.textOf(button))).toEqual(['Edit'])
    expect(rowActionButtons(app, 'docs').map((button) => app.textOf(button))).toEqual(['Edit'])
    app.unmount()
  })

  test('AC-7: label.delete renders every row\'s Delete button and no Edit', async () => {
    const app = mountLabelsPage(['label.delete'])
    await settle()

    expect(rowActionButtons(app, 'bug').map((button) => app.textOf(button))).toEqual(['Delete'])
    expect(rowActionButtons(app, 'docs').map((button) => app.textOf(button))).toEqual(['Delete'])
    app.unmount()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// AC-8 — pages/[project]/threads/index.vue and pages/[project]/threads/new.vue
// ─────────────────────────────────────────────────────────────────────────────

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

function mountThreadsIndex(over: { project?: readonly string[]; threadsEnabled?: boolean } = {}): Mounted {
  const get = permissionsApi({ project: over.project ?? [] })
  installPermissionsRuntime(get)
  const threadsList = {
    threads: ref([]),
    threadsEnabled: ref(over.threadsEnabled ?? true),
    status: ref<'ACTIVE' | 'ARCHIVED'>('ACTIVE'),
    load: jest.fn(async () => true),
  }
  return mountSfc(webFile('pages', '[project]', 'threads', 'index.vue'), {
    components: {
      ...uiStubs,
      FleetThreadsThreadListTable: loadSfc(
        webFile('components', 'fleet', 'threads', 'ThreadListTable.vue'),
        { useI18n: () => pageI18n() },
      ),
    },
    globals: {
      ref, computed, watch, nextTick, onMounted, onBeforeUnmount,
      useI18n: () => pageI18n(),
      useAppToast: () => toastRecorder(),
      useApi: () => ({ $api: { get } }),
      useAsyncData: fakeAsyncData,
      useProjectPermissions,
      useRoute: () => ({ params: { project: 'web' }, query: {} }),
      useRouter: () => ({ replace: jest.fn(async () => undefined) }),
      useThreads: () => threadsList,
      useProjectMemberNames: () => ({ load: jest.fn(async () => undefined), nameOf: () => 'Dana' }),
    },
  })
}

describe('US-007 AC-8: the new-thread link and the create form follow thread.create', () => {
  test('AC-8: thread.create plus threadsEnabled renders the new-thread link', async () => {
    const app = mountThreadsIndex({ project: ['thread.create'], threadsEnabled: true })
    await settle()

    expect(linkTo(app, '/web/threads/new')).toBeDefined()
    app.unmount()
  })

  test('AC-8: without thread.create the link is hidden even with threads enabled', async () => {
    const app = mountThreadsIndex({ project: [], threadsEnabled: true })
    await settle()

    expect(linkTo(app, '/web/threads/new')).toBeUndefined()
    app.unmount()
  })

  test('AC-8: thread.create with threads disabled still hides the link', async () => {
    const app = mountThreadsIndex({ project: ['thread.create'], threadsEnabled: false })
    await settle()

    expect(linkTo(app, '/web/threads/new')).toBeUndefined()
    app.unmount()
  })

  test('AC-8: the new-thread page enables its create form with thread.create', async () => {
    const app = mountNewThreadPage(['thread.create'])
    await settle()

    expect(byTestId(app, 'thread-create-form')).toBeDefined()
    app.unmount()
  })

  test('AC-8: without thread.create the page renders the no-permission notice instead of the form', async () => {
    const app = mountNewThreadPage([])
    await settle()

    expect(byTestId(app, 'thread-create-form')).toBeUndefined()
    expect(app.text()).toContain(enI18n().t('fleet.threads.new.noPermission'))
    app.unmount()
  })
})

function mountNewThreadPage(project: readonly string[]): Mounted {
  const get = permissionsApi({ project })
  installPermissionsRuntime(get)
  const $api = { get, post: jest.fn(async () => ({ id: 'th1' })) }
  return mountSfc(webFile('pages', '[project]', 'threads', 'new.vue'), {
    components: { ...uiStubs, FleetThreadsBackendPicker: inert('StubBackendPicker') },
    globals: {
      ref, computed, watch, nextTick, onMounted, onBeforeUnmount,
      definePageMeta: () => undefined,
      useI18n: () => pageI18n(),
      useAppToast: () => toastRecorder(),
      useApi: () => ({ $api }),
      useAsyncData: fakeAsyncData,
      useProjectPermissions,
      useRoute: () => ({ params: { project: 'web' } }),
      navigateTo: jest.fn(async () => undefined),
      useFleetDispatchOptions: () => ({
        repos: ref([]),
        runners: ref([]),
        moreRepos: ref(false),
        moreRunners: ref(false),
        profileOptions: ref([]),
        labelOptions: ref([]),
        load: jest.fn(async () => undefined),
        repoName: (id: string) => id,
        runnerName: (id: string | null) => id,
      }),
      useProjectSkills: () => ({ list: jest.fn(async () => []) }),
    },
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// AC-9 — pages/[project]/threads/[id].vue → ThreadControls
// ─────────────────────────────────────────────────────────────────────────────

/** Records the `canManage` prop the thread page hands its controls. */
const ThreadControlsRecorder = defineComponent({
  name: 'StubThreadControls',
  props: { canManage: { type: Boolean, default: false }, isCreator: { type: Boolean, default: false } },
  setup(props) {
    return () => h('x-stub-stub', {
      'data-testid': 'thread-controls',
      'data-can-manage': props.canManage === true ? 'true' : 'false',
      'data-is-creator': props.isCreator === true ? 'true' : 'false',
    })
  },
})

const THREAD = {
  id: 'th1', repoId: 'r1', baseRef: 'main', feature: 'add-auth', title: 'Auth spec',
  createdById: 'u1', runnerId: 'r1', backend: { kind: 'native', model: 'gpt-5' }, status: 'ACTIVE',
  archivedAt: null, skills: [], maxCostUsd: '5', costUsd: '0', tokens: null,
  specPath: '.nax/features/add-auth/prd.json', pendingQuestion: null, session: null,
  lastActivityAt: '2026-10-14T00:00:00.000Z', createdAt: '2026-10-14T00:00:00.000Z', activeJob: null,
  sendRefusal: null, writtenPaths: [], publishedSha: null, specPublished: false, lastWrite: null,
  handoff: { plan: null, run: null },
}

function mountThreadDetail(project: readonly string[]): Mounted {
  const get = permissionsApi({ project })
  installPermissionsRuntime(get)
  const inertThread = inert('StubThreadChild')
  return mountSfc(webFile('pages', '[project]', 'threads', '[id].vue'), {
    components: {
      ...uiStubs,
      FleetThreadsThreadControls: ThreadControlsRecorder,
      FleetThreadsThreadHeader: inertThread,
      FleetThreadsThreadStaleBanner: inertThread,
      FleetThreadsThreadKodaToolsNotice: inertThread,
      FleetThreadsThreadProjectCodeNotice: inertThread,
      FleetThreadsThreadActionBar: inertThread,
      FleetThreadsThreadTimeline: inertThread,
      FleetThreadsThreadComposer: inertThread,
    },
    globals: {
      ref, computed, watch, nextTick, onMounted, onBeforeUnmount,
      definePageMeta: () => undefined,
      useI18n: () => pageI18n(),
      useAppToast: () => toastRecorder(),
      useApi: () => ({ $api: { get } }),
      useAsyncData: fakeAsyncData,
      useProjectPermissions,
      useRoute: () => ({ params: { project: 'web', id: 'th1' } }),
      useAuth: () => ({ user: ref({ id: 'u1', email: 'owner@k.t', role: 'MEMBER' }) }),
      useHead: () => undefined,
      useProjectEvents: () => undefined,
      useThreadHandoffJobs: () => ({
        jobs: ref({ plan: null, run: null }),
        sync: jest.fn(async () => undefined),
        refreshJob: jest.fn(async () => undefined),
        isHandoffJob: () => false,
      }),
      useThread: () => ({
        thread: ref(THREAD),
        messages: ref([]),
        live: ref(true),
        load: jest.fn(async () => undefined),
        start: jest.fn(),
        stop: jest.fn(),
        send: jest.fn(async () => ({ ok: true })),
        stopTurn: jest.fn(async () => ({ ok: true })),
        endSession: jest.fn(async () => ({ ok: true })),
        answer: jest.fn(async () => ({ ok: true })),
        raiseCap: jest.fn(async () => ({ ok: true })),
        archive: jest.fn(async () => ({ ok: true })),
        plan: jest.fn(async () => ({ ok: true })),
        publish: jest.fn(async () => ({ ok: true })),
        run: jest.fn(async () => ({ ok: true })),
        discard: jest.fn(async () => ({ ok: true })),
        reloadThread: jest.fn(async () => undefined),
      }),
      useFleetDispatchOptions: () => ({
        repos: ref([]),
        runners: ref([]),
        moreRepos: ref(false),
        moreRunners: ref(false),
        profileOptions: ref([]),
        labelOptions: ref([]),
        load: jest.fn(async () => undefined),
        repoName: (id: string) => id,
        runnerName: (id: string | null) => id,
      }),
    },
  })
}

describe('US-007 AC-9: ThreadControls canManage is thread.archive, never an .own entry', () => {
  test('AC-9: thread.archive passes canManage true', async () => {
    const app = mountThreadDetail(['thread.archive'])
    await settle()

    expect(byTestId(app, 'thread-controls')?.props['data-can-manage']).toBe('true')
    app.unmount()
  })

  test('AC-9: thread.archive.own alone passes canManage false', async () => {
    const app = mountThreadDetail(['thread.archive.own'])
    await settle()

    expect(byTestId(app, 'thread-controls')?.props['data-can-manage']).toBe('false')
    app.unmount()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// AC-10 — components/ProjectSkillsPanel.vue
// ─────────────────────────────────────────────────────────────────────────────

const SKILLS = [
  { id: 'alpha', name: 'alpha-skill', description: 'a', enabled: false, source: { id: 's1', gitUrl: 'https://github.com/o/r', ref: 'main', resolvedSha: '0123456789abcdef', status: 'OK' } },
  { id: 'beta', name: 'beta-skill', description: 'b', enabled: true, source: { id: 's2', gitUrl: 'https://github.com/o/r', ref: 'main', resolvedSha: '0123456789abcdef', status: 'OK' } },
]

/** The real Switch forwards `checked`/`disabled`; this double exposes them to the fake renderer. */
const SwitchStub = defineComponent({
  name: 'StubSwitch',
  props: { checked: { type: Boolean, default: false }, disabled: { type: Boolean, default: false } },
  setup(props, { attrs }) {
    return () => h('x-stub-stub', {
      ...attrs,
      'data-stub': 'switch',
      'data-checked': props.checked === true ? 'true' : 'false',
      'data-disabled': props.disabled === true ? 'true' : 'false',
    })
  },
})

function mountSkillsPanel(project: readonly string[]): Mounted {
  const get = permissionsApi({ project, routes: { '/projects/web/skills': { items: SKILLS } } })
  installPermissionsRuntime(get)
  const $api = { get, put: jest.fn(async () => ({})), delete: jest.fn(async () => ({})) }
  return mountSfc(webFile('components', 'ProjectSkillsPanel.vue'), {
    props: { slug: 'web' },
    components: { ...uiStubs, Switch: SwitchStub },
    globals: {
      ref, computed, watch, nextTick, onMounted, onBeforeUnmount,
      useI18n: () => pageI18n(),
      useAppToast: () => toastRecorder(),
      useApi: () => ({ $api }),
      useAsyncData: fakeAsyncData,
      useProjectPermissions,
      useProjectViewerRole: () => ({ data: ref({ canManage: true, viewerRole: 'ADMIN' }), error: ref(null) }),
      useProjectSkills: () => ({
        list: jest.fn(async () => SKILLS),
        enable: jest.fn(async () => ({})),
        disable: jest.fn(async () => ({})),
      }),
    },
  })
}

const skillSwitchDisabled = (app: Mounted, id: string): unknown =>
  byTestId(app, `skill-switch-${id}`)?.props['data-disabled']

describe('US-007 AC-10: each switch direction follows its own key', () => {
  test('AC-10: skill.project.enable alone enables a disabled skill and locks an enabled one', async () => {
    const app = mountSkillsPanel(['skill.project.enable'])
    await settle()

    // alpha is disabled, so switching it on is what this key allows.
    expect(skillSwitchDisabled(app, 'alpha')).toBe('false')
    // beta is enabled: switching it off needs skill.project.disable.
    expect(skillSwitchDisabled(app, 'beta')).toBe('true')
    app.unmount()
  })

  test('AC-10 (control): skill.project.disable alone is the exact mirror', async () => {
    const app = mountSkillsPanel(['skill.project.disable'])
    await settle()

    expect(skillSwitchDisabled(app, 'alpha')).toBe('true')
    expect(skillSwitchDisabled(app, 'beta')).toBe('false')
    app.unmount()
  })

  test('AC-10 (control): both keys unlock every switch', async () => {
    const app = mountSkillsPanel(['skill.project.enable', 'skill.project.disable'])
    await settle()

    expect(skillSwitchDisabled(app, 'alpha')).toBe('false')
    expect(skillSwitchDisabled(app, 'beta')).toBe('false')
    app.unmount()
  })

  test('AC-10 (control): neither key locks every switch', async () => {
    const app = mountSkillsPanel([])
    await settle()

    expect(skillSwitchDisabled(app, 'alpha')).toBe('true')
    expect(skillSwitchDisabled(app, 'beta')).toBe('true')
    app.unmount()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// AC-11 — components/SettingsKnowledgeCard.vue
// ─────────────────────────────────────────────────────────────────────────────

const KNOWLEDGE = {
  enabled: true,
  patterns: ['docs/**/*.md'],
  customPatterns: false,
  defaultPatterns: ['docs/**/*.md'],
  repos: [{
    repoId: 'r1', owner: 'acme', name: 'app', status: 'idle', indexedSha: 'abcdef1234',
    fileCount: 3, chunkCount: 9, unembeddedCount: 0, skippedCount: 1, lastError: null, finishedAt: null,
  }],
}

function mountKnowledgeCard(project: readonly string[]): Mounted {
  const get = permissionsApi({ project, routes: { '/projects/web/knowledge/repos': KNOWLEDGE } })
  installPermissionsRuntime(get)
  const $api = { get, post: jest.fn(async () => ({ queued: true })), put: jest.fn(async () => ({})) }
  return mountSfc(webFile('components', 'SettingsKnowledgeCard.vue'), {
    props: { slug: 'web' },
    components: uiStubs,
    globals: {
      ref, computed, watch, nextTick, onMounted, onBeforeUnmount,
      useI18n: () => pageI18n(),
      useAppToast: () => toastRecorder(),
      useApi: () => ({ $api }),
      useAsyncData: fakeAsyncData,
      useProjectPermissions,
    },
  })
}

describe('US-007 AC-11: re-index and pattern editing are separate keys', () => {
  test('AC-11: fleet.knowledge.repo.reindex alone renders re-index and a read-only editor without save', async () => {
    const app = mountKnowledgeCard(['fleet.knowledge.repo.reindex'])
    await settle()

    expect(byTestId(app, 'knowledge-reindex-r1')).toBeDefined()
    expect(byTestId(app, 'knowledge-patterns')?.props.readonly).toBe(true)
    expect(byTestId(app, 'knowledge-patterns-save')).toBeUndefined()
    expect(byTestId(app, 'knowledge-patterns-reset')).toBeUndefined()
    app.unmount()
  })

  test('AC-11 (control): fleet.knowledge.patterns.update alone renders an editable editor and save', async () => {
    const app = mountKnowledgeCard(['fleet.knowledge.patterns.update'])
    await settle()

    expect(byTestId(app, 'knowledge-patterns')?.props.readonly).toBe(false)
    expect(byTestId(app, 'knowledge-patterns-save')).toBeDefined()
    expect(byTestId(app, 'knowledge-patterns-reset')).toBeDefined()
    expect(byTestId(app, 'knowledge-reindex-r1')).toBeUndefined()
    app.unmount()
  })

  test('AC-11 (control): neither key leaves the card read-only with no re-index', async () => {
    const app = mountKnowledgeCard([])
    await settle()

    expect(byTestId(app, 'knowledge-reindex-r1')).toBeUndefined()
    expect(byTestId(app, 'knowledge-patterns')?.props.readonly).toBe(true)
    expect(byTestId(app, 'knowledge-patterns-save')).toBeUndefined()
    app.unmount()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// AC-12 — pages/[project]/agents.vue, the status menu on the GLOBAL agent.update key
// ─────────────────────────────────────────────────────────────────────────────

const AGENT_ITEM = {
  slug: 'builder',
  name: 'Build Agent',
  status: 'ACTIVE',
  capabilities: ['code.write'],
  openTicketCount: 0,
  openTicketRefs: [],
  addedAt: '2026-01-01T00:00:00.000Z',
  addedBy: null,
}

interface AgentViewer {
  canManage: boolean
  viewerRole: string | null
}

function mountProjectAgentsPage(global: readonly string[], viewer: AgentViewer): Mounted {
  // The page imports the real useProjectAgents, so the roster arrives through its GET.
  const get = permissionsApi({ global, routes: { '/projects/web/agents': { items: [AGENT_ITEM] } } })
  installPermissionsRuntime(get)
  const agents = {
    items: ref([AGENT_ITEM]),
    pending: ref(false),
    error: ref(null),
    refresh: jest.fn(async () => undefined),
    add: jest.fn(async () => undefined),
    remove: jest.fn(async () => undefined),
    changeStatus: jest.fn(async () => undefined),
  }
  return mountSfc(webFile('pages', '[project]', 'agents.vue'), {
    components: {
      ...uiStubs,
      AddProjectAgentDialog: inert('StubAddProjectAgentDialog'),
    },
    globals: {
      ref, computed, watch, nextTick, onMounted, onBeforeUnmount,
      definePageMeta: () => undefined,
      useI18n: () => pageI18n(),
      useAppToast: () => toastRecorder(),
      useApi: () => ({ $api: { get } }),
      useAsyncData: fakeAsyncData,
      useGlobalPermissions,
      useProjectAgents: () => agents,
      // The legacy roster controls (add dialog, addedBy/addedAt, Remove) keep this gate until US-015;
      // the status menu is what AC-12 isolates, and it must not depend on these flags.
      useProjectViewerRole: () => ({ data: ref({ canManage: viewer.canManage, viewerRole: viewer.viewerRole }), pending: ref(false), error: ref(null), refresh: jest.fn(async () => undefined) }),
      useRoute: () => ({ params: { project: 'web' }, path: '/web/agents' }),
    },
  })
}

describe('US-007 AC-12: the project agents status menu follows the global agent.update', () => {
  /** The legacy project-management flags `useProjectViewerRole` answers (US-015 removes this gate use). */
  const ADMIN_VIEWER = { canManage: true, viewerRole: 'ADMIN' }
  const DEVELOPER_VIEWER = { canManage: false, viewerRole: 'DEVELOPER' }

  test('AC-12: agent.update in the global set renders each row\'s status menu', async () => {
    const app = mountProjectAgentsPage(['agent.update'], ADMIN_VIEWER)
    await settle()

    const row = app.find('[data-stub="tr"]').find((node) => app.textOf(node).includes('builder'))
    expect(row).toBeDefined()
    expect(app.find('select', row)[0]).toBeDefined()
    app.unmount()
  })

  test('AC-12: a non-admin holding agent.update still gets the status menu', async () => {
    // The menu follows the GLOBAL key, not the legacy project-management gate: a custom role that
    // may update agents must be able to do it without project-manager rights.
    const app = mountProjectAgentsPage(['agent.update'], DEVELOPER_VIEWER)
    await settle()

    const row = app.find('[data-stub="tr"]').find((node) => app.textOf(node).includes('builder'))
    expect(row).toBeDefined()
    expect(app.find('select', row)[0]).toBeDefined()
    // The roster controls keep the legacy gate, so no Remove button renders for this viewer.
    expect(app.find('[data-stub="button"]', row).map((button) => app.textOf(button))).not.toContain('Remove')
    app.unmount()
  })

  test('AC-12: without agent.update the status menu is gone', async () => {
    const app = mountProjectAgentsPage([], ADMIN_VIEWER)
    await settle()

    const row = app.find('[data-stub="tr"]').find((node) => app.textOf(node).includes('builder'))
    expect(row).toBeDefined()
    expect(app.find('select', row)).toHaveLength(0)
    app.unmount()
  })

  test('AC-12 (edge): without agent.update and without project management the actions column is gone', async () => {
    const app = mountProjectAgentsPage([], DEVELOPER_VIEWER)
    await settle()

    const row = app.find('[data-stub="tr"]').find((node) => app.textOf(node).includes('builder'))
    expect(row).toBeDefined()
    expect(app.find('select', row)).toHaveLength(0)
    app.unmount()
  })
})
