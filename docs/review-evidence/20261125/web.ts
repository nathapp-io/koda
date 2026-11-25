import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { ApprovalPending } from '../../../apps/api/src/approvals/route/approval-pending'
import { ApprovalPendingFilter } from '../../../apps/api/src/approvals/route/approval-gated.decorator'
import type { ApprovalRequestRecord } from '../../../apps/api/src/approvals/domain/approval.domain'
import { createLiveStream } from '../../../apps/api/src/live/live-stream'
import { ThreadEventBus } from '../../../apps/api/src/live/thread-event-bus'
import { PermissionService } from '../../../apps/api/src/permissions/permission.service'
import type { KodaPrincipal } from '../../../apps/api/src/auth/principal/koda-principal.types'
import { useApi } from '../../../apps/web/composables/useApi'
import { useFleetJobs } from '../../../apps/web/composables/useFleetJobs'
import { useProjectPermissions } from '../../../apps/web/composables/usePermissions'
import { useThread } from '../../../apps/web/composables/useThread'
import { useThreads } from '../../../apps/web/composables/useThreads'
import { useWorkspaceThread } from '../../../apps/web/composables/useWorkspaceThread'
import { useWorkspaceThreads } from '../../../apps/web/composables/useWorkspaceThreads'
import { createThreadController } from '../../../apps/web/lib/thread-controller'
import type { ChatMessageDto } from '../../../apps/web/lib/thread-types'
import { loadSfc, mountSfc, webFile } from '../../../apps/web/tests/helpers/mount-sfc'

const webRequire = createRequire(webFile('package.json'))
const { getCurrentInstance, nextTick, ref } = webRequire('vue') as typeof import('vue')
const nuxtRequire = createRequire(webRequire.resolve('nuxt/package.json'))
const { ofetch } = nuxtRequire('ofetch')
const i18n = () => ({ t: (key: string) => key, te: () => false, locale: ref('en') })
const date = new Date('2026-11-25T00:00:00Z')
const user = ref({ id: 'viewer', name: 'Local reviewer' })
const noop = () => undefined
const auth = () => ({ user, refreshSession: async () => 'ok' })
const route = { params: { project: 'review', id: 'thread-1' }, query: {} }

async function settle() {
  await new Promise<void>(resolve => setImmediate(resolve))
  await nextTick()
}

const ok = (data: unknown, status = 200) => Response.json({ ret: 0, data }, { status })
let respond: (request: Request) => Response | Promise<Response> = request => {
  throw new Error(`Unexpected request ${request.method} ${request.url}`)
}
const calls: string[] = []
const fetchFixture = ofetch.create({
  baseURL: 'http://local-fixture.invalid',
  retry: 0,
}, {
  fetch: async (url: string, options: RequestInit) => {
    const request = new Request(url, options)
    calls.push(`${request.method} ${new URL(request.url).pathname}${new URL(request.url).search}`)
    return respond(request)
  },
})
Object.assign(globalThis, {
  $fetch: fetchFixture,
  useApi,
  useAuth: auth,
  useI18n: i18n,
  useRuntimeConfig: () => ({ apiInternalUrl: 'http://local-fixture.invalid', public: { apiBaseUrl: '/api' } }),
  useAsyncData: (_key: string, load: () => Promise<unknown>) => {
    const data = ref<unknown>(null)
    const error = ref<unknown>(null)
    const pending = ref(true)
    const refresh = async () => {
      pending.value = true
      try { data.value = await load() }
      catch (failure) { error.value = failure }
      finally { pending.value = false }
    }
    void refresh()
    return { data, error, pending, refresh }
  },
})

const transcriptMessage: ChatMessageDto = {
  id: 'message-1', seq: 1, jobId: null, turnId: null, role: 'assistant', authorUserId: null,
  clientMessageId: null, content: 'Partial response', toolSummary: null, status: 'streaming',
  errorReason: null, usage: null, costUsd: null, costSource: null, createdAt: date.toISOString(),
}
const settledMessage = { ...transcriptMessage, status: 'complete', content: 'Final response' }
const detail = {
  id: 'thread-1', kind: 'PROJECT', createdById: 'viewer', mode: 'read', title: 'Proof thread',
  homeProject: null, archivedAt: null, status: 'ACTIVE', activeJob: null, session: null,
  backend: { kind: 'native', model: 'fixture' }, pendingApprovals: [], sendRefusal: null,
  costUsd: '0', maxCostUsd: '5', lastActivityAt: date.toISOString(),
}

function approvalResponse(permissionKey: string): Response {
  const record: ApprovalRequestRecord = {
    id: `approval-${permissionKey}`, permissionKey, projectId: 'project-1',
    actor: { type: 'USER', id: user.value.id }, onBehalfOf: null,
    origin: 'rest', correlationId: 'local', input: {}, inputHash: 'local',
    requiredMode: 'human', policyId: 'policy-1', onTimeout: 'reject',
    approverMustHoldAction: true, requireDistinctApprover: true, status: 'pending',
    satisfiedBy: null, approverType: null, approverId: null, result: null,
    expiresAt: new Date(date.getTime() + 1000), decidedAt: null, settledAt: null, createdAt: date,
  }
  let response: Response | undefined
  const adapter = { reply: (_target: unknown, body: unknown, status: number) => {
    response = Response.json(body, { status })
  } }
  const filter = new ApprovalPendingFilter({ httpAdapter: adapter } as never)
  filter.catch(new ApprovalPending(record), { switchToHttp: () => ({ getResponse: () => ({}) }) } as never)
  assert.equal(response?.status, 202)
  return response!
}

const passthrough = { template: '<div><slot /></div>' }
const inert = { template: '<span />' }
const button = { template: '<button><slot /></button>' }

async function ticketSubmit(response: () => Response) {
  calls.length = 0
  respond = () => response()
  const toasts: string[] = []
  const app = mountSfc(webFile('components', 'CreateTicketDialog.vue'), {
    props: { open: true, projectSlug: 'review' },
    globals: { useApi, useI18n: i18n, useAppToast: () => ({ success: (message: string) => toasts.push(message), error: noop }) },
    components: {
      Dialog: passthrough, DialogContent: passthrough, DialogHeader: inert, DialogTitle: inert,
      FormField: inert, FormItem: inert, FormLabel: inert, FormControl: inert, FormMessage: inert,
      Input: inert, FleetNativeSelect: inert, Button: button,
    },
    alias: {
      '~/components/MarkdownEditor.vue': { default: inert, __esModule: true },
      // The fixture provides valid form values. Submission logic and the client are production code.
      'vee-validate': { useForm: () => ({
        handleSubmit: (run: (input: unknown) => Promise<void>) => () => run({ title: 'Proof ticket', type: 'BUG', priority: 'MEDIUM' }),
        isSubmitting: ref(false), resetForm: noop,
      }) },
    },
  })
  try {
    await (app.one('form')!.props.onSubmit as () => Promise<void>)()
    assert.deepEqual(calls, ['POST /api/projects/review/tickets'])
    return { toasts, created: app.emitted('created').length, open: app.emitted('update:open').map(args => args[0]) }
  } finally { app.unmount() }
}

async function fleetCancel(pending: boolean) {
  const route = { params: { project: 'review', id: 'job-1' } }
  const path = '/api/projects/review/fleet/jobs/job-1'
  const job = {
    id: 'job-1', repoId: 'repo-1', requestedById: user.value.id, ref: 'main',
    state: 'RUNNING', command: 'RUN', feature: 'proof', profiles: [], bashMode: 'raw',
    queuedAt: date.toISOString(), cancelRequestedAt: null, resultPrUrl: null,
  }
  const toasts: string[] = []
  const errors: unknown[] = []
  calls.length = 0
  respond = request => {
    switch (new URL(request.url).pathname) {
      case path: return ok(job)
      case `${path}/events`: return ok({ records: [] })
      case `${path}/cancel`: return pending
        ? approvalResponse('fleet.job.cancel')
        : ok({ ...job, cancelRequestedAt: date.toISOString() })
      case '/api/approvals': return ok({ records: [] })
      case '/api/me/permissions': return ok({ keys: ['fleet.job.cancel'] })
      default: throw new Error(request.url)
    }
  }
  const decorativeComponents = [
    'FleetJobProgress.vue', 'story-graph/FleetJobPipeline.vue', 'FleetJobTimeline.vue',
    'FleetJobWorkflow.vue', 'FleetJobOpenItems.vue', 'FleetJobAgentResult.vue', 'FleetPlacementResult.vue',
    'config/ConfigJobPanel.vue', 'config/ConfigPrDialog.vue', 'JobApprovals.vue', 'JobAnalytics.vue',
  ]
  const app = mountSfc(webFile('pages', '[project]', 'fleet', 'jobs', '[id]', 'index.vue'), {
    globals: {
      ...threadGlobals,
      useRoute: () => route, useFleetJobs,
      useFleetDispatchOptions: () => ({ settled: ref(true), load: async () => undefined, repoName: () => 'Repository', runnerName: () => 'Runner' }),
      useProjectMemberNames: () => ({ load: async () => undefined, nameOf: () => null }),
      useFleetRepoConfig: () => ({}),
      useFleetJobLogs: () => ({ list: async () => ({ attempts: [] }) }),
      useAppToast: () => {
        getCurrentInstance()!.appContext.config.errorHandler = error => { errors.push(error) }
        return { success: (message: string) => toasts.push(message), error: (message: string) => errors.push(message) }
      },
    },
    components: {
      ...loadState, PageHeader: { template: '<header><slot name="actions" /></header>' },
      FleetBudgetBanner: inert, NuxtLink: inert, Button: button,
      Dialog: { props: ['open'], template: '<div v-if="open"><slot /></div>' }, DialogContent: passthrough,
      DialogHeader: inert, DialogTitle: inert, DialogDescription: inert, DialogFooter: passthrough,
    },
    alias: {
      ...Object.fromEntries(decorativeComponents.map(file => [`~/components/fleet/${file}`, { default: inert, __esModule: true }])),
      '~/components/fleet/FleetJobStateBadge.vue': { default: { props: ['state'], template: '<span data-testid="job-state">{{ state }}</span>' }, __esModule: true },
      '~/composables/useApprovalCountdown': { useApprovalCountdown: () => ({ now: ref(date) }) },
    },
  })
  try {
    await settle()
    assert.equal(app.textOf(app.one('[data-testid="job-state"]')!), 'RUNNING')
    ;(app.one('[data-testid="fleet-job-cancel"]')!.props.onClick as () => void)()
    await nextTick()
    await (app.one('[data-testid="fleet-job-cancel-confirm"]')!.props.onClick as () => Promise<void>)()
    await settle()
    assert.equal(calls.filter(call => call === `POST ${path}/cancel`).length, 1)
    assert.deepEqual(toasts, ['fleet.jobs.toast.cancelRequested'])
    if (pending) {
      assert.ok(errors.some(error => error instanceof TypeError && error.message.includes('length')))
    } else {
      assert.deepEqual(errors, [])
      assert.equal(app.textOf(app.one('[data-testid="job-state"]')!), 'RUNNING')
      assert.ok(app.one('[data-testid="fleet-job-cancel-pending"]'))
    }
  } finally { app.unmount() }
}

async function approvalProof() {
  const pending = await ticketSubmit(() => approvalResponse('ticket.create'))
  const created = await ticketSubmit(() => ok({ id: 'ticket-1', ref: 'REVIEW-1' }, 201))
  assert.deepEqual(pending, created)
  assert.deepEqual(pending, { toasts: ['tickets.toast.created'], created: 1, open: [false] })
  await fleetCancel(true)
  await fleetCancel(false)

  const controller = createThreadController({
    api: useApi().$api, slug: 'review', threadId: 'thread-1',
    openStream: () => ({ close: noop }), setTimer: () => null, clearTimer: noop, now: () => date.getTime(),
  })
  respond = () => approvalResponse('thread.message.send')
  const submission = await controller.send('Wait for approval')
  assert.equal(submission.ok, false)
  assert.ok(submission.error instanceof TypeError)
  assert.match(submission.error.message, /clientMessageId/)
  assert.equal(controller.messages.value.length, 0)

  respond = async request => {
    const { clientMessageId, text } = await request.json()
    const message = { ...transcriptMessage, id: 'sent-1', role: 'user', status: 'pending', content: text, clientMessageId }
    return ok({ message, jobId: null }, 201)
  }
  assert.deepEqual(await controller.send('Proceed immediately'), { ok: true })
  assert.deepEqual(controller.messages.value.map(message => message.id), ['sent-1'])
  respond = () => ok({ queued: true }, 202)
  assert.deepEqual(await useApi().$api.post('/projects/review/knowledge/repos/repo-1/reindex'), { queued: true })
  console.log('10: Pending 202 and executed 201 produced the same ticket toast, created event and form close. Pending cancellation showed the success toast and caused a render TypeError; executed cancellation kept the job visible. Pending thread send raised TypeError; normal send succeeded. Queued 202 returned { queued: true }.')
}

class FixtureEventSource {
  static opened: FixtureEventSource[] = []
  readonly listeners = new Map<string, (event: { data: string }) => void>()
  readyState = 1
  onopen: (() => void) | null = null
  onerror: (() => void) | null = null
  closed = false
  constructor(readonly url: string) { FixtureEventSource.opened.push(this) }
  addEventListener(name: string, listener: (event: { data: string }) => void) { this.listeners.set(name, listener) }
  close() { this.closed = true }
  emit(name: string, data: unknown = {}) { this.listeners.get(name)?.({ data: JSON.stringify(data) }) }
}
Object.assign(globalThis, { EventSource: FixtureEventSource })

const threadGlobals = {
  useApi, useAuth: auth, useI18n: i18n, useRoute: () => route, useThread, useWorkspaceThread,
  useThreadHandoffJobs: () => ({ jobs: ref([]) }), useProjectEvents: noop,
  useFleetDispatchOptions: () => ({ runners: ref([]), load: async () => undefined }),
  useProjectRunnerSummaries: () => ({ runners: ref([]), load: async () => undefined }),
  useProjectPermissions, useProjectPermissionsFor: () => ({ permissions: ref({ hasOwn: () => false }) }),
  useAppToast: () => ({ error: noop }),
}
const loadState = {
  LoadingState: { template: '<span data-testid="loading-state">Loading</span>' },
  ErrorState: { emits: ['retry'], template: '<button data-testid="error-retry" @click="$emit(\'retry\')">Retry</button>' },
}
const threadChildren = {
  ...loadState,
  FleetThreadsThreadHeader: { props: ['thread'], template: '<h1>{{ thread.title }}</h1>' },
  FleetThreadsThreadTimeline: {
    props: ['messages'],
    template: '<div><p v-for="message in messages" :key="message.id" :data-status="message.status">{{ message.content }}</p></div>',
  },
  FleetThreadsThreadComposer: {
    props: ['composerState', 'turnRunning'],
    template: '<input data-testid="composer" :data-reason="composerState.reason" :disabled="!composerState.canSend" />',
  },
  FleetThreadsThreadControls: inert, FleetThreadsThreadStaleBanner: inert, FleetThreadsThreadKodaToolsNotice: inert,
  FleetThreadsThreadProjectCodeNotice: inert, FleetThreadsThreadActionBar: inert, FleetThreadsThreadQueuedNotice: inert,
  FleetThreadsThreadFlowsPanel: inert, FleetThreadsThreadStartFlow: inert, FleetThreadsThreadPreApprovalCard: inert,
  FleetThreadsThreadApprovalCard: inert, FleetThreadsThreadModeControl: inert,
}
const mountThread = (workspace = false) => mountSfc(
  webFile('pages', ...(workspace ? [] : ['[project]']), 'threads', '[id].vue'),
  { components: threadChildren, globals: threadGlobals },
)

async function streamGapProof() {
  for (const workspace of [false, true]) {
    let messages: ChatMessageDto[] = [transcriptMessage]
    const bus = new ThreadEventBus()
    const name = workspace ? 'workspace' : 'project'
    const prefix = workspace ? '/api/threads/thread-1' : '/api/projects/review/threads/thread-1'
    calls.length = 0
    FixtureEventSource.opened.length = 0
    respond = request => {
      switch (new URL(request.url).pathname) {
        case '/api/me/permissions': return ok({ keys: [] })
        case prefix: return ok(detail)
        case `${prefix}/messages`: return ok({ items: messages })
        default: throw new Error(request.url)
      }
    }
    const app = mountThread(workspace)
    let subscription: { unsubscribe: () => void } | undefined
    try {
      await settle()
      assert.equal(app.one('[data-status="streaming"]')?.tag, 'p')
      const source = FixtureEventSource.opened[0]
      assert.ok(source)
      assert.equal(source.url, `${prefix}/events`)
      const connect = () => {
        source.onopen?.()
        subscription = createLiveStream({
          key: detail.id, heartbeatMs: 60_000, expiresAtMs: null, now: Date.now,
          subscribe: (id, listener) => bus.subscribe(id, listener), stillAllowed: async () => true, onClose: noop,
        }).subscribe(event => source.emit(event.type!, event.data))
      }
      // Runner finishes after the snapshot and before the server accepts the SSE subscription.
      messages = [settledMessage]
      bus.publish({ type: 'message', id: 'finished', threadId: detail.id, messageId: transcriptMessage.id, at: date.toISOString() })
      const before = calls.filter(call => call.includes(prefix)).length
      connect()
      await settle()
      assert.equal(calls.filter(call => call.includes(prefix)).length, before)
      assert.equal(app.one('[data-status="streaming"]')?.tag, 'p')
      assert.equal(app.one('[data-testid="composer"]')?.props.disabled, true)

      // A real EventSource reconnect after a nonterminal error triggers the existing resync.
      subscription!.unsubscribe()
      source.onerror?.()
      connect()
      await settle()
      assert.equal(calls.filter(call => call.includes(prefix)).length, before + 2)
      assert.match(app.text(), /Final response/)
      assert.equal(app.one('[data-testid="composer"]')?.props.disabled, false)
      console.log(`11 ${name}: first ready made 0 catch-up GETs and left composer disabled. Reconnect made 2 GETs and enabled composer.`)
    } finally {
      subscription?.unsubscribe()
      app.unmount()
    }
  }
}

async function threadErrorProof() {
  for (const status of [403, 404, 503]) {
    respond = request => new URL(request.url).pathname === '/api/me/permissions'
      ? ok({ keys: [] })
      : Response.json({ message: `Fixture ${status}` }, { status })
    const app = mountThread()
    try {
      await settle()
      assert.equal(app.text(), '')
      assert.equal(app.find('button').length, 0)
    } finally { app.unmount() }
  }

  let retryReady = false
  respond = request => {
    const path = new URL(request.url).pathname
    if (path === '/api/me/permissions') return ok({ keys: [] })
    if (!retryReady) return Response.json({ message: 'Fixture 503' }, { status: 503 })
    return path.endsWith('/messages') ? ok({ items: [] }) : ok(detail)
  }
  const app = mountThread(true)
  try {
    await settle()
    const retry = app.one('[data-testid="error-retry"]')
    assert.ok(retry)
    retryReady = true
    await (retry.props.onClick as () => Promise<void>)()
    await settle()
    assert.match(app.text(), /Proof thread/)
    assert.equal(app.one('[data-testid="error-retry"]'), undefined)
  } finally { app.unmount() }
  console.log('12: Project GET errors 403, 404 and 503 all produced 0 visible characters and 0 retry buttons. Workspace 503 rendered retry and recovered.')
}

async function paginationProof() {
  const paginationCalls: Array<{ scope: string; status: string; page: number; size: number }> = []
  respond = request => {
    const url = new URL(request.url)
    if (url.pathname === '/api/me/permissions') return ok({ keys: ['thread.create'] })
    const scope = url.pathname.includes('/projects/') ? 'project' : 'workspace'
    const status = url.searchParams.get('status') ?? ''
    const page = Number(url.searchParams.get('page') ?? 1)
    const size = Number(url.searchParams.get('size'))
    paginationCalls.push({ scope, status, page, size })
    const threads = Array.from({ length: 101 }, (_, i) => ({ ...detail, id: `thread-${i + 1}`, title: `Thread ${i + 1}`, status }))
    return ok({ items: threads.slice((page - 1) * size, page * size), threadsEnabled: true })
  }
  const globals = { ...threadGlobals, useThreads, useWorkspaceThreads, useProjectMemberNames: () => ({ load: async () => undefined, nameOf: () => null }) }
  const link = { props: ['to'], template: '<a :href="to"><slot /></a>' }
  const components = {
    ...loadState, PageHeader: inert, Button: button, NuxtLink: link,
    FleetThreadsThreadListTable: loadSfc(webFile('components', 'fleet', 'threads', 'ThreadListTable.vue'), globals),
  }
  const mountList = (workspace: boolean) => mountSfc(
    webFile('pages', ...(workspace ? [] : ['[project]']), 'threads', 'index.vue'),
    { components, globals },
  )
  const project = mountList(false)
  try {
    await settle()
    assert.equal(project.find('tbody > tr').length, 100)
    assert.ok(project.one('[href="/review/threads/thread-100"]'))
    assert.equal(project.one('[href="/review/threads/thread-101"]'), undefined)
    const projectButtons = project.find('button')
    assert.equal(projectButtons.length, 2)
    const archived = projectButtons.find(node => project.textOf(node) === 'fleet.threads.list.archived')!
    await (archived.props.onClick as () => Promise<void>)()
    await settle()
    assert.equal(project.find('tbody > tr').length, 100)
    assert.equal(project.one('[href="/review/threads/thread-101"]'), undefined)
  } finally { project.unmount() }

  const workspace = mountList(true)
  try {
    await settle()
    assert.equal(workspace.find('tbody > tr').length, 100)
    const loadMore = workspace.one('[data-testid="threads-load-more"]')
    assert.ok(loadMore)
    await (loadMore.props.onClick as () => Promise<void>)()
    await settle()
    assert.equal(workspace.find('tbody > tr').length, 101)
    assert.ok(workspace.one('[href="/threads/thread-101"]'))
  } finally { workspace.unmount() }
  assert.deepEqual(paginationCalls, [
    { scope: 'project', status: 'ACTIVE', page: 1, size: 100 },
    { scope: 'project', status: 'ARCHIVED', page: 1, size: 100 },
    { scope: 'workspace', status: 'ACTIVE', page: 1, size: 100 },
    { scope: 'workspace', status: 'ACTIVE', page: 2, size: 100 },
  ])
  console.log('13: Project rendered 100 of 101 active and archived rows and only requested page 1. Workspace load-more requested page 2 and rendered all 101.')
}

async function permissionProof() {
  const projectId = 'project-1'
  const key = 'thread.message.send'
  const principal = { actorType: 'user', id: user.value.id } as KodaPrincipal
  for (const { name, owner, grant, allowed, composer } of [
    { name: 'delegated', owner: 'different-author', grant: key, allowed: true, composer: false },
    { name: 'own-only other thread', owner: 'different-author', grant: `${key}.own`, allowed: false, composer: false },
    { name: 'own-only own thread', owner: principal.id, grant: `${key}.own`, allowed: true, composer: true },
    { name: 'missing grant own thread', owner: principal.id, grant: null, allowed: false, composer: true },
  ]) {
    const row = { roleKey: 'fixture', roleScope: 'PROJECT', rolePermissions: grant ? [grant] : [], binding: { projectId } }
    const permissions = new PermissionService({} as never, { findEffectiveBindings: async () => [row] } as never, {
      remember: (_parts: string[], load: () => Promise<unknown>) => load(),
    } as never)
    const permission = await permissions.can(principal, key, { projectId, resource: { createdBy: { type: 'USER', id: owner } } })
    assert.equal(permission.allowed, allowed)
    if (name === 'delegated') assert.equal((await permissions.can(principal, key, { projectId })).allowed, true)
    const keys = [...await permissions.effectiveKeys({ type: 'USER', id: principal.id }, { projectId })]
    assert.deepEqual(keys, grant ? [grant] : [])
    respond = request => {
      const path = new URL(request.url).pathname
      if (path === '/api/me/permissions') return ok({ keys })
      return path.endsWith('/messages') ? ok({ items: [] }) : ok({ ...detail, createdById: owner })
    }
    const app = mountThread()
    try {
      await settle()
      const element = app.one('[data-testid="composer"]')
      assert.ok(element)
      assert.equal(!element.props.disabled, composer)
      console.log(`14 ${name}: API permission ${permission.reason}; composer ${element.props.disabled ? element.props['data-reason'] : 'enabled'}.`)
    } finally { app.unmount() }
  }
}

await approvalProof()
await streamGapProof()
await threadErrorProof()
await paginationProof()
await permissionProof()
