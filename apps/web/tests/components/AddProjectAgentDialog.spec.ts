import { describe, test, expect, jest } from '@jest/globals'
import * as Vue from 'vue'
import { computed, defineComponent, h, ref, watch } from 'vue'
import { mountSfc, webFile } from '../helpers/mount-sfc'
import { enI18n, uiStubs } from '../helpers/fleet-harness'
import { ApiError, extractApiError } from '../../composables/useApi'
import type { ProjectAgent } from '../../composables/useProjectAgents'

const dialog = webFile('components', 'AddProjectAgentDialog.vue')

interface AgentChoice {
  slug: string
  name: string
  status: 'ACTIVE' | 'PAUSED' | 'OFFLINE'
}

interface GetMock {
  (...args: unknown[]): Promise<unknown>
  mock: { calls: unknown[][] }
}

type Get = GetMock

function passthrough(tag: string): unknown {
  return defineComponent({
    name: `Stub${tag}`,
    inheritAttrs: false,
    setup(_props: unknown, { slots, attrs }: { slots: Record<string, (() => unknown) | undefined>; attrs: Record<string, unknown> }) {
      return () => h('x-stub-stub', { ...attrs, 'data-stub': tag }, [
        ...(slots.default?.() ?? []),
      ])
    },
  })
}

function controlledSelect(): unknown {
  return defineComponent({
    name: 'StubSelect',
    props: { modelValue: { type: String, default: '' }, disabled: { type: Boolean, default: false } },
    emits: ['update:modelValue'],
    setup(props, { slots, emit, attrs }) {
      return () => h('x-stub-stub', {
        ...attrs,
        'data-stub': 'select',
        modelValue: props.modelValue,
        disabled: props.disabled,
        setModelValue: (value: string) => emit('update:modelValue', value),
        onUpdateModelValue: (value: string) => emit('update:modelValue', value),
      }, slots.default?.() ?? [])
    },
  })
}

function selectItemStub(): unknown {
  return defineComponent({
    name: 'StubSelectItem',
    props: { value: { type: String, required: true } },
    setup(props, { slots, attrs }) {
      return () => h('x-stub-stub', {
        ...attrs,
        'data-stub': 'select-item',
        value: props.value,
      }, slots.default?.() ?? [])
    },
  })
}

interface MountOptions {
  open: boolean
  slug: string
  roster: ProjectAgent[]
  error: string | null
  agents: AgentChoice[]
  get?: Get
  submitting?: boolean
}

interface DialogHandle {
  app: ReturnType<typeof mountSfc>
  settle: () => Promise<void>
  get: Get
  setOpen: (open: boolean) => Promise<void>
}

function mountDialog(options: MountOptions): DialogHandle {
  const get: Get = options.get ?? (jest.fn(async () => options.agents) as unknown as Get)
  const mounted = mountSfc(dialog, {
    props: {
      open: options.open,
      slug: options.slug,
      roster: options.roster,
      error: options.error,
      submitting: options.submitting ?? false,
    },
    components: {
      ...uiStubs,
      Select: controlledSelect(),
      SelectTrigger: passthrough('select-trigger'),
      SelectValue: passthrough('select-value'),
      SelectContent: passthrough('select-content'),
      SelectItem: selectItemStub(),
    },
    globals: {
      ref, computed, watch,
      useI18n: () => enI18n(),
      useApi: () => ({ $api: { get } }),
      extractApiError,
    },
  })

  const settle = async (): Promise<void> => {
    for (let i = 0; i < 12; i += 1) {
      await new Promise((resolve) => { setImmediate(resolve) })
      await Vue.nextTick()
    }
  }

  const setOpen = async (open: boolean): Promise<void> => {
    mounted.setProps({ open })
    await Vue.nextTick()
  }

  return { app: mounted, settle, get, setOpen }
}

const rostered: ProjectAgent = {
  slug: 'rostered-agent',
  name: 'Rostered Agent',
  status: 'ACTIVE',
  roles: ['CODER'],
  capabilities: ['code.write'],
  openTicketCount: 0,
  openTicketRefs: [],
  addedAt: '2026-01-01T00:00:00.000Z',
  addedBy: null,
}

describe('AddProjectAgentDialog (US-006 AC3-5)', () => {
  test('AC3: opening the dialog calls GET /agents and excludes rostered and OFFLINE rows', async () => {
    const agents: AgentChoice[] = [
      { slug: 'rostered-agent', name: 'Rostered', status: 'ACTIVE' },
      { slug: 'offline-agent', name: 'Offline', status: 'OFFLINE' },
      { slug: 'available-agent', name: 'Available', status: 'ACTIVE' },
      { slug: 'paused-agent', name: 'Paused', status: 'PAUSED' },
    ]
    const get: Get = jest.fn(async () => agents) as unknown as Get
    const { app, settle, setOpen } = mountDialog({
      open: false, slug: 'acme', roster: [rostered], error: null, agents, get,
    })
    await setOpen(true)
    await settle()

    expect(get.mock.calls.map(call => call[0])).toEqual(['/agents'])

    const itemValues = app.find('[data-stub="select-item"]').map(item => item.props.value)
    expect(itemValues).toEqual(['available-agent', 'paused-agent'])
    app.unmount()
  })

  test('AC3: an empty GET /agents result leaves the picker empty', async () => {
    const { app, settle, setOpen } = mountDialog({
      open: false, slug: 'acme', roster: [], error: null, agents: [], get: jest.fn(async () => []) as unknown as Get,
    })
    await setOpen(true)
    await settle()
    expect(app.find('[data-stub="select-item"]')).toHaveLength(0)
    app.unmount()
  })

  test('AC3: a failing GET /agents surfaces the extracted error in the candidates-error pane', async () => {
    const get: Get = jest.fn(async () => { throw new ApiError(503, 'agents down') }) as unknown as Get
    const { app, settle, setOpen } = mountDialog({
      open: false, slug: 'acme', roster: [], error: null, agents: [], get,
    })
    await setOpen(true)
    await settle()
    expect(app.text()).toContain('agents down')
    expect(app.find('[data-stub="select-item"]')).toHaveLength(0)
    app.unmount()
  })

  test('AC4: confirming a selected agent emits added with the chosen slug', async () => {
    const agents: AgentChoice[] = [{ slug: 'available-agent', name: 'Available', status: 'ACTIVE' }]
    const { app, settle, setOpen } = mountDialog({
      open: false, slug: 'acme', roster: [], error: null, agents, get: jest.fn(async () => agents) as unknown as Get,
    })
    await setOpen(true)
    await settle()
    const select = app.one('[data-stub="select"]')
    if (!select) throw new Error('Select was not rendered')
    const setValue = select.props.setModelValue as (value: string) => void
    setValue('available-agent')
    await settle()
    const buttons = app.find('[data-stub="button"]')
    const confirm = buttons.find(button => /Add agent/.test(app.textOf(button)))
    if (!confirm) throw new Error('Confirm button was not rendered')
    ;(confirm.props.onClick as (event: Event) => void)({ preventDefault: jest.fn() } as unknown as Event)
    expect(app.emitted('added')).toEqual([['available-agent']])
    app.unmount()
  })

  test('AC4: confirming without a selection does not emit added', async () => {
    const agents: AgentChoice[] = [{ slug: 'available-agent', name: 'Available', status: 'ACTIVE' }]
    const { app, settle, setOpen } = mountDialog({
      open: false, slug: 'acme', roster: [], error: null, agents, get: jest.fn(async () => agents) as unknown as Get,
    })
    await setOpen(true)
    await settle()
    const buttons = app.find('[data-stub="button"]')
    const confirm = buttons.find(button => /Add agent/.test(app.textOf(button)))
    if (!confirm) throw new Error('Confirm button was not rendered')
    ;(confirm.props.onClick as (event: Event) => void)({ preventDefault: jest.fn() } as unknown as Event)
    expect(app.emitted('added')).toEqual([])
    app.unmount()
  })

  test('WEB-2: while the add POST is in flight Confirm is disabled and does not emit added', async () => {
    const agents: AgentChoice[] = [{ slug: 'available-agent', name: 'Available', status: 'ACTIVE' }]
    const { app, settle, setOpen } = mountDialog({
      open: false, slug: 'acme', roster: [], error: null, agents, get: jest.fn(async () => agents) as unknown as Get,
      submitting: true,
    })
    await setOpen(true)
    await settle()
    const select = app.one('[data-stub="select"]')
    const setValue = select?.props.setModelValue as (value: string) => void
    setValue('available-agent')
    await settle()
    const buttons = app.find('[data-stub="button"]')
    const confirm = buttons.find(button => /Add agent/.test(app.textOf(button)))
    if (!confirm) throw new Error('Confirm button was not rendered')
    expect(confirm.props.disabled).toBe(true)
    ;(confirm.props.onClick as (event: Event) => void)({ preventDefault: jest.fn() } as unknown as Event)
    expect(app.emitted('added')).toEqual([])
    app.unmount()
  })

  test('AC5: the dialog renders a forwarded POST error in the error pane', async () => {
    const agents: AgentChoice[] = [{ slug: 'available-agent', name: 'Available', status: 'ACTIVE' }]
    const { app, setOpen } = mountDialog({
      open: false, slug: 'acme', roster: [], error: 'Roster add failed', agents, get: jest.fn(async () => agents) as unknown as Get,
    })
    await setOpen(true)
    await Vue.nextTick()
    expect(app.text()).toContain('Roster add failed')
    app.unmount()
  })

  test('AC4: cancel emits update:open false', async () => {
    const agents: AgentChoice[] = []
    const { app, settle, setOpen } = mountDialog({
      open: false, slug: 'acme', roster: [], error: null, agents, get: jest.fn(async () => agents) as unknown as Get,
    })
    await setOpen(true)
    await settle()
    const buttons = app.find('[data-stub="button"]')
    const cancel = buttons.find(button => /cancel/i.test(app.textOf(button)))
    if (!cancel) throw new Error('Cancel button was not rendered')
    ;(cancel.props.onClick as (event: Event) => void)({ preventDefault: jest.fn() } as unknown as Event)
    expect(app.emitted('update:open')).toEqual([[false]])
    app.unmount()
  })
})
