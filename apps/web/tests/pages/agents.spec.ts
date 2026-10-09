import { describe, test, expect, jest } from '@jest/globals'
import { existsSync, readFileSync, statSync } from 'fs'
import { join } from 'path'
import vm from 'vm'

// US-006 checklist (one task per AC):
// AC1 roster rows/data and empty boundary — roster response exposes every item field.
// AC2 admin/global-admin controls and non-admin boundary — role controls are derived from viewer role.
// AC3 available-agent filtering and OFFLINE boundary — existing and offline agents are omitted.
// AC4 successful add and reload — confirm posts selected slug then refreshes roster.
// AC5 add failure — extracted error is surfaced and dialog remains open.
// AC6 zero-open-ticket removal and confirmation boundary — confirm before DELETE and reload after.
// AC7 blocked removal — count 2 prevents DELETE and provides two ticket references.
// AC8 stale-count conflict — extracted error is surfaced and roster refreshed.
// AC9 scoping disabled — informational state is exposed.
// AC10 no roster entries — empty state is exposed.

const webDir = join(__dirname, '../..')
const pagePath = join(webDir, 'pages', '[project]', 'agents.vue')

function resolveBunPackage(pkgName: string): string {
  let dir: string = __dirname
  const bunName = pkgName.startsWith('@') ? pkgName.replace('/', '+') : pkgName
  for (let i = 0; i < 100; i++) {
    const bunRoot = join(dir, 'node_modules', '.bun')
    if (existsSync(bunRoot) && statSync(bunRoot).isDirectory()) {
      const entries = (require('fs') as typeof import('fs')).readdirSync(bunRoot)
      for (const entry of entries.filter(e => e.startsWith(`${bunName}@`)).sort().reverse()) {
        const inner = join(bunRoot, entry, 'node_modules', pkgName)
        if (existsSync(inner)) return inner
      }
    }
    const parent = join(dir, '..')
    if (parent === dir) break
    dir = parent
  }
  throw new Error(`Could not locate ${pkgName} from ${__dirname}`)
}

// eslint-disable-next-line @typescript-eslint/no-var-requires
const sfc = require(resolveBunPackage('@vue/compiler-sfc'))
// eslint-disable-next-line @typescript-eslint/no-var-requires
const esbuild = require(resolveBunPackage('esbuild'))
// eslint-disable-next-line @typescript-eslint/no-var-requires
const Vue = require(resolveBunPackage('vue'))

interface FetchCall { method: string; url: string; body?: unknown }
interface AgentEntry {
  name: string
  slug: string
  roles: string[]
  capabilities: string[]
  status: 'ACTIVE' | 'PAUSED' | 'OFFLINE'
  openTicketCount: number
  openTicketRefs: string[]
}

async function mountPage(options: {
  response?: unknown
  agentsResponse?: unknown
  role?: string
  globalAdmin?: boolean
  confirm?: boolean
  reject?: Error
}) {
  const calls: FetchCall[] = []
  const responses = [options.response ?? { scoping: true, items: [] }]
  const toast = { success: jest.fn(), error: jest.fn() }
  const api = {
    get: async (url: string) => {
      calls.push({ method: 'GET', url })
      if (url === '/agents') return options.agentsResponse ?? []
      return responses[0]
    },
    post: async (url: string, body: unknown) => {
      calls.push({ method: 'POST', url, body })
      if (options.reject) throw options.reject
      return {}
    },
    delete: async (url: string) => {
      calls.push({ method: 'DELETE', url })
      if (options.reject) throw options.reject
      return {}
    },
    patch: async (url: string, body: unknown) => { calls.push({ method: 'PATCH', url, body }); return {} },
  }
  const source = readFileSync(pagePath, 'utf-8')
  const { descriptor } = sfc.parse(source)
  const script = sfc.compileScript(descriptor, { id: pagePath })
  const code = script.content
    .replace(/~\/lib\/api-path/g, join(webDir, 'lib/api-path'))
    .replace('return __returned__', 'globalThis.__PAGE_STATE__ = __returned__; return __returned__')
  const bundle = await esbuild.build({
    stdin: { contents: code, resolveDir: webDir, loader: 'ts' },
    bundle: true, format: 'cjs', platform: 'node', write: false,
    external: ['vue', 'lucide-vue-next'],
  })
  const sandbox: Record<string, unknown> = {
    module: { exports: {} }, exports: {}, require, __dirname: webDir, __filename: pagePath,
    console, process, Buffer, setTimeout, clearTimeout,
    ref: Vue.ref, computed: Vue.computed,
    useRoute: () => ({ params: { project: 'acme' }, path: '/acme/agents' }),
    useI18n: () => ({ t: (key: string) => key }),
    useAppToast: () => toast,
    definePageMeta: () => {},
    useAsyncData: (_key: string, fetcher: () => Promise<unknown>) => {
      const data = Vue.ref<unknown>(null)
      const pending = Vue.ref(true)
      const error = Vue.ref(null)
      const refresh = async () => {
        pending.value = true
        try { data.value = await fetcher(); error.value = null }
        catch (caught) { error.value = caught }
        finally { pending.value = false }
      }
      void refresh()
      return { data, pending, error, refresh }
    },
    useProjectViewerRole: () => ({ role: options.role ?? 'ADMIN', isAdmin: options.role === 'ADMIN', isGlobalAdmin: options.globalAdmin ?? false }),
    useProjectAgents: () => ({
      items: Vue.ref((options.response as { items?: AgentEntry[] } | undefined)?.items ?? []),
      scoping: Vue.ref((options.response as { scoping?: boolean } | undefined)?.scoping ?? true),
      refresh: jest.fn(async () => { calls.push({ method: 'GET', url: '/projects/acme/agents' }) }),
      add: async (agentSlug: string) => api.post('/projects/acme/agents', { agentSlug }),
      remove: async (agentSlug: string) => api.delete(`/projects/acme/agents/${agentSlug}`),
    }),
    useApi: () => ({ $api: api }),
    extractApiError: (error: Error) => error.message,
    confirm: () => options.confirm ?? true,
  }
  sandbox.globalThis = sandbox
  vm.createContext(sandbox as vm.Context)
  vm.runInContext(bundle.outputFiles[0].text, sandbox as vm.Context)
  const component = (sandbox.module as { exports: { default?: { setup?: (...args: unknown[]) => unknown } } }).exports.default
  const setup = component?.setup
  if (typeof setup !== 'function') throw new Error('Page setup was not compiled')
  const bindings = setup({}, { expose: () => {}, attrs: {}, slots: {}, emit: () => {} }) as Record<string, unknown>
  await new Promise(resolve => setTimeout(resolve, 0))
  return { bindings, calls, toast, api }
}

const rosterItem: AgentEntry = {
  name: 'Build Agent', slug: 'builder', roles: ['CODER'], capabilities: ['code.write'],
  status: 'ACTIVE', openTicketCount: 0, openTicketRefs: [],
}

describe('US-006 project agent roster page', () => {
  test('US-006 AC1: loads roster entries including roles, capabilities, status, and open count', async () => {
    const { bindings, calls } = await mountPage({ response: { scoping: true, items: [rosterItem] } })
    expect(calls.some(call => call.method === 'GET' && call.url === '/projects/acme/agents')).toBe(true)
    const items = bindings.items as { value: AgentEntry[] } | undefined
    expect(items?.value).toEqual([rosterItem])
  })

  test('US-006 AC1: an empty roster contains no rows', async () => {
    const { bindings } = await mountPage({ response: { scoping: true, items: [] } })
    const items = bindings.items as { value: AgentEntry[] } | undefined
    expect(items?.value).toHaveLength(0)
  })

  test('US-006 AC2: a project ADMIN can access roster management controls', async () => {
    const { bindings } = await mountPage({ role: 'ADMIN' })
    expect(bindings.canManage).toBe(true)
  })

  test('US-006 AC2: a global ADMIN can access roster management controls', async () => {
    const { bindings } = await mountPage({ role: 'MEMBER', globalAdmin: true })
    expect(bindings.canManage).toBe(true)
  })

  test('US-006 AC2: a non-admin cannot access roster management controls', async () => {
    const { bindings } = await mountPage({ role: 'MEMBER' })
    expect(bindings.canManage).toBe(false)
  })

  test('US-006 AC3: available agent choices exclude rostered and OFFLINE agents', async () => {
    const { bindings } = await mountPage({
      response: { scoping: true, items: [rosterItem] },
      agentsResponse: [rosterItem, { ...rosterItem, slug: 'offline', status: 'OFFLINE' }, { ...rosterItem, slug: 'available' }],
    })
    const loadCandidates = bindings.loadCandidates as (() => Promise<void>) | undefined
    expect(typeof loadCandidates).toBe('function')
    await loadCandidates?.()
    const candidates = bindings.availableAgents as { value: Array<{ slug: string }> } | undefined
    expect(candidates?.value.map(agent => agent.slug)).toEqual(['available'])
  })

  test('US-006 AC3: an empty GET /agents result produces no add choices', async () => {
    const { bindings } = await mountPage({ agentsResponse: [] })
    const loadCandidates = bindings.loadCandidates as (() => Promise<void>) | undefined
    expect(typeof loadCandidates).toBe('function')
    await loadCandidates?.()
    const candidates = bindings.availableAgents as { value: unknown[] } | undefined
    expect(candidates?.value).toEqual([])
  })

  test('US-006 AC4: confirming an agent posts its slug and refreshes the roster', async () => {
    const { bindings, calls } = await mountPage({})
    const addAgent = bindings.addAgent as ((slug: string) => Promise<void>) | undefined
    expect(typeof addAgent).toBe('function')
    await addAgent?.('builder')
    expect(calls).toContainEqual({ method: 'POST', url: '/projects/acme/agents', body: { agentSlug: 'builder' } })
    expect(calls.filter(call => call.method === 'GET' && call.url === '/projects/acme/agents').length).toBeGreaterThan(1)
  })

  test('US-006 AC4: confirming without a selected slug does not post', async () => {
    const { bindings, calls } = await mountPage({})
    const addAgent = bindings.addAgent as ((slug: string) => Promise<void>) | undefined
    expect(typeof addAgent).toBe('function')
    await addAgent?.('')
    expect(calls.filter(call => call.method === 'POST')).toHaveLength(0)
  })

  test('US-006 AC5: failed add shows the extracted error and leaves the dialog open', async () => {
    const { bindings, toast } = await mountPage({ reject: new Error('Roster add failed') })
    const addAgent = bindings.addAgent as ((slug: string) => Promise<void>) | undefined
    expect(typeof addAgent).toBe('function')
    await addAgent?.('builder')
    expect(toast.error).toHaveBeenCalledWith('Roster add failed')
    expect(bindings.addDialogOpen).toEqual({ value: true })
  })

  test('US-006 AC6: confirmed removal of an agent with no open tickets sends DELETE and reloads', async () => {
    const { bindings, calls } = await mountPage({ response: { scoping: true, items: [rosterItem] }, confirm: true })
    const removeAgent = bindings.removeAgent as ((agent: AgentEntry) => Promise<void>) | undefined
    expect(typeof removeAgent).toBe('function')
    await removeAgent?.(rosterItem)
    expect(calls.some(call => call.method === 'DELETE' && call.url === '/projects/acme/agents/builder')).toBe(true)
    expect(calls.filter(call => call.method === 'GET' && call.url === '/projects/acme/agents').length).toBeGreaterThan(1)
  })

  test('US-006 AC6: cancelling removal does not send DELETE', async () => {
    const { bindings, calls } = await mountPage({ confirm: false })
    const removeAgent = bindings.removeAgent as ((agent: AgentEntry) => Promise<void>) | undefined
    expect(typeof removeAgent).toBe('function')
    await removeAgent?.(rosterItem)
    expect(calls.filter(call => call.method === 'DELETE')).toHaveLength(0)
  })

  test('US-006 AC7: agent with two open tickets cannot be removed and exposes ticket references', async () => {
    const blocked = { ...rosterItem, openTicketCount: 2, openTicketRefs: ['KODA-11', 'KODA-12'] }
    const { bindings, calls } = await mountPage({ response: { scoping: true, items: [blocked] } })
    const removeAgent = bindings.removeAgent as ((agent: AgentEntry) => Promise<void>) | undefined
    expect(typeof removeAgent).toBe('function')
    await removeAgent?.(blocked)
    expect(calls.filter(call => call.method === 'DELETE')).toHaveLength(0)
    expect(bindings.blockedTicketRefs).toEqual({ value: ['KODA-11', 'KODA-12'] })
  })

  test('US-006 AC7: zero ticket refs do not produce a blocked-removal message', async () => {
    const { bindings } = await mountPage({ response: { scoping: true, items: [rosterItem] } })
    expect(bindings.blockedTicketRefs).toEqual({ value: [] })
  })

  test('US-006 AC8: a 409 remove failure surfaces the error and refreshes roster data', async () => {
    const { bindings, calls, toast } = await mountPage({ reject: Object.assign(new Error('Roster changed'), { statusCode: 409 }) })
    const removeAgent = bindings.removeAgent as ((agent: AgentEntry) => Promise<void>) | undefined
    expect(typeof removeAgent).toBe('function')
    await removeAgent?.(rosterItem)
    expect(toast.error).toHaveBeenCalledWith('Roster changed')
    expect(calls.filter(call => call.method === 'GET' && call.url === '/projects/acme/agents').length).toBeGreaterThan(1)
  })

  test('US-006 AC9: scoping false is exposed as the scoping-off state', async () => {
    const { bindings } = await mountPage({ response: { scoping: false, items: [rosterItem] } })
    expect(bindings.scoping).toEqual({ value: false })
  })

  test('US-006 AC10: empty roster exposes the empty state', async () => {
    const { bindings } = await mountPage({ response: { scoping: true, items: [] } })
    const items = bindings.items as { value: AgentEntry[] } | undefined
    expect(items?.value).toHaveLength(0)
    expect(bindings.isEmpty).toBe(true)
  })
})
