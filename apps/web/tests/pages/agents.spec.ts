import { describe, test, expect, jest, beforeEach, afterEach } from '@jest/globals'
import * as Vue from 'vue'
import { computed, defineComponent, h, onMounted, ref, shallowRef, watch } from 'vue'
import { mountSfc, webFile } from '../helpers/mount-sfc'
import { enI18n, uiStubs } from '../helpers/fleet-harness'
import { extractApiError } from '../../composables/useApi'
import { useProjectAgents, type ProjectAgent } from '../../composables/useProjectAgents'

const page = webFile('pages', '[project]', 'agents.vue')

interface RosterResponse {
  scoping: boolean
  items: Array<{
    name: string
    slug: string
    status: 'ACTIVE' | 'PAUSED' | 'OFFLINE'
    roles: string[]
    capabilities: string[]
    openTicketCount: number
    openTicketRefs: string[]
    addedAt?: string
    addedBy?: { id: string; name: string | null } | null
  }>
}

const makeRoster = (over: Partial<RosterResponse> = {}): RosterResponse => ({
  scoping: true,
  items: [],
  ...over,
})

const item: ProjectAgent = {
  slug: 'builder',
  name: 'Build Agent',
  status: 'ACTIVE',
  roles: ['CODER'],
  capabilities: ['code.write'],
  openTicketCount: 0,
  openTicketRefs: [],
  addedAt: '2026-01-01T00:00:00.000Z',
  addedBy: null,
}

const blocked: ProjectAgent = {
  ...item,
  slug: 'blocked',
  openTicketCount: 2,
  openTicketRefs: ['KODA-11', 'KODA-12'],
}

interface FetchCall { method: string; url: string; body?: unknown }
interface DialogStub { added: (slug: string) => void; close: () => void }

interface MountOptions {
  rosterResponse?: RosterResponse
  agentsResponse?: Array<{ slug: string; name: string; status: string }>
  role?: 'ADMIN' | 'MEMBER'
  globalAdmin?: boolean
  rejectAdd?: Error
  rejectDelete?: Error
  rejectPatch?: Error
  confirm?: boolean
  dialogStub?: DialogStub
}

interface PageHandle {
  app: ReturnType<typeof mountSfc>
  settle: () => Promise<void>
  calls: FetchCall[]
  toast: { success: jest.Mock; error: jest.Mock }
  confirm: (msg: string) => boolean
  dialog: DialogStub
  byText: (text: string) => Vue.Element | undefined
  byTestId: (id: string) => Vue.Element | undefined
  rows: () => Vue.Element[]
  invokeDialogAdded: (slug: string) => Promise<void>
  invokeRemoveButton: (agent: ProjectAgent) => Promise<void>
  api: { get: jest.Mock; post: jest.Mock; delete: jest.Mock; patch: jest.Mock }
}

/**
 * Captures the dialog's prop callbacks. The page passes the dialog a `:roster`, `:slug`,
 * `:error`, and listens for `@update:open` and `@added`. Recording these lets the test
 * drive the dialog as if a user had selected an agent and confirmed, without a real
 * AddProjectAgentDialog in the tree.
 */
const dialogCaptures: { current: { readonly open: boolean; roster: ProjectAgent[]; error: string | null; addedHandler?: (slug: string) => void; openHandler?: (open: boolean) => void } | null } = { current: null }

const dialogStub = defineComponent({
  name: 'StubAddProjectAgentDialog',
  props: { open: { type: Boolean, default: false }, slug: { type: String, default: '' }, roster: { type: Array, default: () => [] }, error: { type: String as () => string | null, default: null } },
  emits: ['update:open', 'added'],
  setup(props, { emit }) {
    // The captured `open` is a ref that re-points at the prop every render, so the test reads
    // the current value through it instead of the stale closure from the first render.
    const openRef = ref(props.open)
    watch(() => props.open, (value) => { openRef.value = value })
    watch(() => props.error, (value) => {
      if (dialogCaptures.current) dialogCaptures.current.error = value as string | null
    })
    watch(() => props.roster, (value) => {
      if (dialogCaptures.current) dialogCaptures.current.roster = value as ProjectAgent[]
    })
    dialogCaptures.current = {
      get open() { return openRef.value },
      roster: props.roster as ProjectAgent[],
      error: props.error,
      addedHandler: (slug: string) => emit('added', slug),
      openHandler: (value: boolean) => emit('update:open', value),
    }
    return () => h('x-stub-stub', { 'data-stub': 'add-project-agent-dialog', open: props.open, error: props.error }, props.slug)
  },
})

const linkStub = defineComponent({
  name: 'StubNuxtLink',
  props: { to: { default: null } },
  setup(props, { slots, attrs }) {
    return () => h('x-stub-stub', { ...attrs, 'data-stub': 'nuxt-link', to: props.to }, [
      ...(slots.default?.() ?? []),
    ])
  },
})

function mountPage(options: MountOptions = {}): PageHandle {
  const calls: FetchCall[] = []
  const toast = { success: jest.fn(), error: jest.fn() }
  const confirm = jest.fn(() => options.confirm ?? true)
  ;(globalThis as { confirm?: unknown }).confirm = confirm
  const rosterResponse = options.rosterResponse ?? makeRoster()
  const agentsResponse = options.agentsResponse ?? []

  const api = {
    get: jest.fn(async (path: string) => {
      calls.push({ method: 'GET', url: path })
      if (path === '/agents') {
        return agentsResponse
      }
      if (path === '/projects/acme/members') {
        return { canManage: options.role === 'ADMIN' || options.globalAdmin === true, viewerRole: options.role ?? null }
      }
      if (path === '/projects/acme/agents') {
        return rosterResponse
      }
      return null
    }),
    post: jest.fn(async (path: string, body: unknown) => {
      calls.push({ method: 'POST', url: path, body })
      if (options.rejectAdd) throw options.rejectAdd
      return {}
    }),
    delete: jest.fn(async (path: string) => {
      calls.push({ method: 'DELETE', url: path })
      if (options.rejectDelete) throw options.rejectDelete
      return {}
    }),
    patch: jest.fn(async (path: string, body: unknown) => {
      calls.push({ method: 'PATCH', url: path, body })
      if (options.rejectPatch) throw options.rejectPatch
      return {}
    }),
  }

  const app = mountSfc(page, {
    components: {
      ...uiStubs,
      AddProjectAgentDialog: dialogStub,
      NuxtLink: linkStub,
    },
    globals: {
      ref, computed, watch, shallowRef, onMounted,
      useI18n: () => enI18n(),
      useAppToast: () => toast,
      useApi: () => ({ $api: api }),
      extractApiError,
      useProjectAgents: () => useProjectAgents('acme'),
      useProjectViewerRole: () => ({
        data: ref({ canManage: options.role === 'ADMIN' || options.globalAdmin === true, viewerRole: options.role ?? null }),
        pending: ref(false),
        error: ref(null),
        refresh: async () => undefined,
      }),
      useAsyncData: () => ({
        data: ref(null),
        pending: ref(false),
        error: ref(null),
        refresh: async () => undefined,
      }),
      useRoute: () => ({ params: { project: 'acme' }, path: '/acme/agents' }),
      definePageMeta: () => undefined,
    },
  })

  const settle = async (): Promise<void> => {
    for (let i = 0; i < 8; i += 1) {
      await new Promise((resolve) => { setImmediate(resolve) })
      await Vue.nextTick()
    }
  }

  const rows = (): Vue.Element[] => {
    const all = app.find('[data-stub="tr"]')
    return all.filter(row => row.parent?.props['data-stub'] === 'tbody') as unknown as Vue.Element[]
  }

  const byText = (text: string) => app.find('[data-stub="button"]').find(b => app.textOf(b) === text)[0]

  const dialog: DialogStub = {
    added: (slug) => dialogCaptures.current?.addedHandler?.(slug),
    close: () => dialogCaptures.current?.openHandler?.(false),
  }

  const invokeDialogAdded = async (slug: string): Promise<void> => {
    dialog.added(slug)
    await settle()
  }

  const invokeRemoveButton = async (agent: ProjectAgent): Promise<void> => {
    // The page renders a `<TableRow>` per item; the row contains a cell with the agent's slug.
    // Walk all rows under tbody and find the one whose text includes the slug.
    const bodyRows = app.find('[data-stub="tr"]').filter(row => row.parent?.props['data-stub'] === 'tbody')
    const target = bodyRows.find(row => app.textOf(row).includes(agent.slug))
    if (!target) throw new Error(`No row for ${agent.slug}; found: ${bodyRows.map(r => app.textOf(r)).join(' | ')}`)
    const buttons = app.find('[data-stub="button"]', target)
    const remove = buttons.find(b => /Remove/.test(app.textOf(b)))
    if (!remove) throw new Error(`No Remove button for ${agent.slug}; buttons: ${buttons.map(b => app.textOf(b)).join(' | ')}`)
    ;(remove.props.onClick as (e: Event) => void)({ preventDefault: jest.fn() } as unknown as Event)
    await settle()
  }

  return {
    app, settle, calls, toast, confirm: confirm as unknown as (msg: string) => boolean, dialog,
    byText: (text) => byText(text) as Vue.Element | undefined,
    byTestId: (id) => app.find(`[data-testid="${id}"]`)[0],
    rows: rows as () => Vue.Element[],
    invokeDialogAdded,
    invokeRemoveButton,
    api,
  }
}

beforeEach(() => {
  dialogCaptures.current = null
})

afterEach(() => {
  delete (globalThis as { confirm?: unknown }).confirm
  dialogCaptures.current = null
})

describe('US-006 project agent roster page', () => {
  test('AC1: GET /projects/:slug/agents populates one row per item with name, slug, roles, capabilities, status, and open-ticket count', async () => {
    const richItem: ProjectAgent = {
      slug: 'builder', name: 'Build Agent', status: 'ACTIVE',
      roles: ['CODER', 'REVIEWER'], capabilities: ['code.write', 'lint.run'],
      openTicketCount: 2, openTicketRefs: ['KODA-11', 'KODA-12'],
      addedAt: '2026-01-01T00:00:00.000Z', addedBy: null,
    }
    const m = mountPage({ rosterResponse: makeRoster({ items: [richItem] }) })
    await m.settle()

    expect(m.calls.some(c => c.method === 'GET' && c.url === '/projects/acme/agents')).toBe(true)
    const rows = m.rows()
    expect(rows).toHaveLength(1)
    const rowText = m.app.textOf(rows[0])
    expect(rowText).toContain('Build Agent')
    expect(rowText).toContain('builder')
    expect(rowText).toContain('CODER')
    expect(rowText).toContain('REVIEWER')
    expect(rowText).toContain('code.write')
    expect(rowText).toContain('lint.run')
    expect(rowText).toContain('ACTIVE')
    expect(rowText).toContain('2')
  })

  test('AC10: an empty roster renders the "No agents on this project yet." empty state', async () => {
    const m = mountPage({ rosterResponse: makeRoster({ items: [] }) })
    await m.settle()
    const emptyState = m.app.find('[data-stub="empty-state"]')
    expect(emptyState).toHaveLength(1)
    expect(emptyState[0].props.message).toBe('No agents on this project yet.')
  })

  test('AC9: a roster response with scoping: false renders the scoping-off note', async () => {
    const m = mountPage({ rosterResponse: makeRoster({ scoping: false, items: [item] }) })
    await m.settle()
    const note = m.app.find('[data-testid="project-agents-scoping-off"]')
    expect(note).toHaveLength(1)
  })

  test('AC2: a project ADMIN sees Add and Remove controls', async () => {
    const m = mountPage({ role: 'ADMIN', rosterResponse: makeRoster({ items: [item] }) })
    await m.settle()
    const addButton = m.app.find('[data-stub="button"]').find(b => /Add agent/.test(m.app.textOf(b)))
    expect(addButton).toBeDefined()
    const removeButton = m.app.find('[data-stub="button"]').find(b => /Remove/.test(m.app.textOf(b)))
    expect(removeButton).toBeDefined()
  })

  test('AC2: a global ADMIN sees Add and Remove controls even with a project MEMBER role', async () => {
    const m = mountPage({ role: 'MEMBER', globalAdmin: true, rosterResponse: makeRoster({ items: [item] }) })
    await m.settle()
    const addButton = m.app.find('[data-stub="button"]').find(b => /Add agent/.test(m.app.textOf(b)))
    expect(addButton).toBeDefined()
    const removeButton = m.app.find('[data-stub="button"]').find(b => /Remove/.test(m.app.textOf(b)))
    expect(removeButton).toBeDefined()
  })

  test('AC2: a non-admin member does not see Add or Remove controls', async () => {
    const m = mountPage({ role: 'MEMBER', rosterResponse: makeRoster({ items: [item] }) })
    await m.settle()
    const addButton = m.app.find('[data-stub="button"]').find(b => /Add agent/.test(m.app.textOf(b)))
    expect(addButton).toBeUndefined()
    const removeButton = m.app.find('[data-stub="button"]').find(b => /Remove/.test(m.app.textOf(b)))
    expect(removeButton).toBeUndefined()
  })

  test('AC4: the page POSTs { agentSlug } to /projects/:slug/agents when the dialog emits added', async () => {
    const m = mountPage({ rosterResponse: makeRoster({ items: [item] }), role: 'ADMIN' })
    await m.settle()
    await m.invokeDialogAdded('available-agent')
    expect(m.calls).toContainEqual({ method: 'POST', url: '/projects/acme/agents', body: { agentSlug: 'available-agent' } })
  })

  test('AC4: a successful add reloads the roster (a second GET to /projects/:slug/agents)', async () => {
    const m = mountPage({ rosterResponse: makeRoster({ items: [item] }), role: 'ADMIN' })
    await m.settle()
    const beforeCount = m.calls.filter(c => c.method === 'GET' && c.url === '/projects/acme/agents').length
    await m.invokeDialogAdded('available-agent')
    const afterCount = m.calls.filter(c => c.method === 'GET' && c.url === '/projects/acme/agents').length
    expect(afterCount).toBeGreaterThan(beforeCount)
  })

  test('AC5: a failed add shows the extracted error and keeps the dialog open', async () => {
    const m = mountPage({
      rosterResponse: makeRoster({ items: [item] }),
      role: 'ADMIN',
      rejectAdd: Object.assign(new Error('Roster add failed'), { statusCode: 400 }),
    })
    await m.settle()
    await m.invokeDialogAdded('available-agent')
    expect(dialogCaptures.current?.error).toBe('Roster add failed')
    expect(dialogCaptures.current?.open).toBe(true)
  })

  test('AC6: removing an agent with 0 open tickets asks for confirmation, then DELETEs and reloads', async () => {
    const m = mountPage({ rosterResponse: makeRoster({ items: [item] }), role: 'ADMIN', confirm: true })
    await m.settle()
    const beforeGet = m.calls.filter(c => c.method === 'GET' && c.url === '/projects/acme/agents').length
    await m.invokeRemoveButton(item)
    expect(m.confirm).toHaveBeenCalled()
    expect(m.calls.some(c => c.method === 'DELETE' && c.url === '/projects/acme/agents/builder')).toBe(true)
    const afterGet = m.calls.filter(c => c.method === 'GET' && c.url === '/projects/acme/agents').length
    expect(afterGet).toBeGreaterThan(beforeGet)
  })

  test('AC6: cancelling the confirmation does not DELETE', async () => {
    const m = mountPage({ rosterResponse: makeRoster({ items: [item] }), role: 'ADMIN', confirm: false })
    await m.settle()
    await m.invokeRemoveButton(item)
    expect(m.calls.filter(c => c.method === 'DELETE')).toHaveLength(0)
  })

  test('AC7: removing an agent with 2 open tickets does not DELETE and surfaces the "Reassign" message with ticket refs', async () => {
    const m = mountPage({ rosterResponse: makeRoster({ items: [blocked] }), role: 'ADMIN' })
    await m.settle()
    await m.invokeRemoveButton(blocked)
    expect(m.calls.filter(c => c.method === 'DELETE')).toHaveLength(0)
    const blockedMessage = m.app.find('[data-testid="project-agents-blocked-message"]')
    expect(blockedMessage).toHaveLength(1)
    expect(m.app.textOf(blockedMessage[0])).toBe('Reassign its 2 open tickets first')
    const linkNodes = m.app.find('[data-stub="nuxt-link"]')
    const refs = linkNodes.map(node => node.props.to)
    expect(refs).toEqual(expect.arrayContaining([
      expect.stringContaining('KODA-11'),
      expect.stringContaining('KODA-12'),
    ]))
  })

  test('AC8: a 409 on DELETE shows the extracted error and reloads the roster', async () => {
    const error = Object.assign(new Error('Roster changed'), { statusCode: 409 })
    const m = mountPage({ rosterResponse: makeRoster({ items: [item] }), role: 'ADMIN', confirm: true, rejectDelete: error })
    await m.settle()
    const beforeGet = m.calls.filter(c => c.method === 'GET' && c.url === '/projects/acme/agents').length
    await m.invokeRemoveButton(item)
    expect(m.toast.error).toHaveBeenCalledWith('Roster changed')
    const afterGet = m.calls.filter(c => c.method === 'GET' && c.url === '/projects/acme/agents').length
    expect(afterGet).toBeGreaterThan(beforeGet)
  })

  test('WEB-1: a failed status PATCH reverts the select to the row status and toasts', async () => {
    const error = Object.assign(new Error('Status refused'), { statusCode: 409 })
    const m = mountPage({ rosterResponse: makeRoster({ items: [item] }), role: 'ADMIN', rejectPatch: error })
    await m.settle()
    const select = m.app.one('select')
    expect(select).toBeDefined()
    // The user picks PAUSED; the PATCH fails. The page must put the refused
    // value back: refresh() alone cannot, because the reloaded items carry
    // the same status and Vue never re-patches the select.
    const target = { value: 'PAUSED' } as unknown as HTMLSelectElement
    ;(select?.props.onChange as (e: Event) => void)({ target } as unknown as Event)
    await m.settle()
    expect(m.api.patch).toHaveBeenCalledWith('/projects/acme/agents/builder', { status: 'PAUSED' })
    expect(target.value).toBe('ACTIVE')
    expect(m.toast.error).toHaveBeenCalledWith('Status refused')
  })

  test('WEB-5: while a status PATCH is in flight the row controls are disabled', async () => {
    let release: (value: unknown) => void = () => undefined
    const m = mountPage({ rosterResponse: makeRoster({ items: [item] }), role: 'ADMIN' })
    await m.settle()
    m.api.patch.mockImplementationOnce(() => new Promise((resolve) => { release = resolve }))
    const select = m.app.one('select')
    ;(select?.props.onChange as (e: Event) => void)({ target: { value: 'PAUSED' } } as unknown as Event)
    await Vue.nextTick()
    expect(m.app.one('select')?.props.disabled).toBe(true)
    release(undefined)
    await m.settle()
    expect(m.app.one('select')?.props.disabled).toBe(false)
  })

  test('WEB-2: a second `added` while the add POST is in flight does not POST twice', async () => {
    let release: (value: unknown) => void = () => undefined
    const m = mountPage({ rosterResponse: makeRoster({ items: [item] }), role: 'ADMIN' })
    await m.settle()
    m.api.post.mockImplementationOnce(() => new Promise((resolve) => { release = resolve }))
    // Two emits in the same tick: a double-click on Confirm before the first
    // POST settles. The page guard must swallow the second one.
    m.dialog.added('available-agent')
    m.dialog.added('available-agent')
    release(undefined)
    await m.settle()
    // mockImplementationOnce replaces the recorder, so count on the mock itself.
    expect(m.api.post).toHaveBeenCalledTimes(1)
    expect(m.api.post).toHaveBeenCalledWith('/projects/acme/agents', { agentSlug: 'available-agent' })
  })
})
