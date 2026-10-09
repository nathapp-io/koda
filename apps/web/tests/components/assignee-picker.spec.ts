import { describe, expect, test, jest } from '@jest/globals'
import { nextTick, ref } from 'vue'
import { mountSfc, webFile } from '../helpers/mount-sfc'
import { enI18n, uiStubs } from '../helpers/fleet-harness'

const pickerFile = webFile('components', 'AssigneePicker.vue')
const propertiesFile = webFile('components', 'TicketProperties.vue')
const propertyStubs = { ...uiStubs, Select: uiStubs.Button, SelectTrigger: uiStubs.Button, SelectValue: uiStubs.Button, SelectContent: uiStubs.Button, SelectItem: uiStubs.Button }
const flush = async (): Promise<void> => {
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
  await nextTick()
}

describe('AssigneePicker and ticket assignment (US-007)', () => {
  test('AC1: sends one assignee search 200 ms after typing stops', async () => {
    jest.useFakeTimers()
    const get = jest.fn(async () => ({ items: [] }))
    const app = mountSfc(pickerFile, {
      props: { projectSlug: 'web' },
      components: uiStubs,
      globals: { useApi: () => ({ $api: { get } }), useI18n: () => enI18n() },
    })
    const input = app.one('[data-testid="assignee-search"]')
    expect(input).toBeDefined()
    const update = input?.props['onUpdate:modelValue']
    expect(update).toBeInstanceOf(Function)
    ;(update as (value: string) => void)('alice')
    await nextTick()
    jest.advanceTimersByTime(199)
    await nextTick()
    expect(get).not.toHaveBeenCalled()
    jest.advanceTimersByTime(1)
    await flush()
    expect(get).toHaveBeenCalledTimes(1)
    expect(get).toHaveBeenCalledWith('/projects/web/assignees', { query: { q: 'alice' } })
    app.unmount()
    jest.useRealTimers()
  })

  test('AC2: shows users and agents in separate groups and marks paused agents', async () => {
    const get = jest.fn(async () => ({ items: [
      { type: 'user', id: 'u1', name: 'Alice', secondary: 'alice@example.test' },
      { type: 'agent', id: 'a1', name: 'Builder', secondary: 'builder', status: 'PAUSED' },
    ] }))
    const app = mountSfc(pickerFile, {
      props: { projectSlug: 'web' },
      components: uiStubs,
      globals: { useApi: () => ({ $api: { get } }), useI18n: () => enI18n() },
    })
    const input = app.one('[data-testid="assignee-search"]')
    expect(input).toBeDefined()
    const update = input?.props['onUpdate:modelValue']
    expect(update).toBeInstanceOf(Function)
    ;(update as (value: string) => void)('')
    await flush()
    expect(app.one('[data-testid="assignee-group-people"]')).toBeDefined()
    expect(app.one('[data-testid="assignee-group-agents"]')).toBeDefined()
    expect(app.text()).toContain('Alice')
    expect(app.text()).toContain('Builder')
    expect(app.text()).toContain('(paused)')
    app.unmount()
  })

  test.each([
    ['user', 'u1', { userId: 'u1' }],
    ['agent', 'a1', { agentId: 'a1' }],
  ] as const)('AC3/AC4: selecting %s sends the typed assignment and emits changed', async (type, id, body) => {
    const post = jest.fn(async () => undefined)
    const app = mountSfc(propertiesFile, {
      props: {
        ticket: { id: 't1', ref: 'WEB-1', title: 'Ticket', type: 'TASK', priority: 'LOW', status: 'CREATED', createdAt: '2026-01-01T00:00:00Z' },
        projectSlug: 'web', ticketRef: 'WEB-1', ticketLinks: [], allLabels: [], canWork: true, canManage: false,
      },
      components: propertyStubs,
      alias: { '~/components/TicketActionPanel.vue': { default: { render: () => null } } },
      globals: {
        useApi: () => ({ $api: { post, get: jest.fn(async () => ({})), delete: jest.fn(async () => undefined) } }),
        useI18n: () => ({ ...enI18n(), locale: ref('en') }), useAppToast: () => ({ success: jest.fn(), error: jest.fn() }),
        safeHref: (value: string) => value,
      },
    })
    const choice = app.one(`[data-testid="assignee-option-${id}"]`)
    expect(choice).toBeDefined()
    const click = choice?.props.onClick
    expect(click).toBeInstanceOf(Function)
    ;(click as () => void)()
    await flush()
    expect(post).toHaveBeenCalledWith('/projects/web/tickets/WEB-1/assign', body)
    expect(app.emitted('changed')).toHaveLength(1)
    expect(type).toMatch(/user|agent/)
    app.unmount()
  })

  test('AC5: a 409 assignment error is displayed and does not emit changed', async () => {
    const failure = Object.assign(new Error('conflict'), { statusCode: 409, data: { message: 'Assignment conflict' } })
    const post = jest.fn(async () => { throw failure })
    const toastError = jest.fn()
    const app = mountSfc(propertiesFile, {
      props: {
        ticket: { id: 't1', ref: 'WEB-1', title: 'Ticket', type: 'TASK', priority: 'LOW', status: 'CREATED', createdAt: '2026-01-01T00:00:00Z' },
        projectSlug: 'web', ticketRef: 'WEB-1', ticketLinks: [], allLabels: [], canWork: true, canManage: false,
      },
      components: propertyStubs,
      alias: { '~/components/TicketActionPanel.vue': { default: { render: () => null } } },
      globals: {
        useApi: () => ({ $api: { post, get: jest.fn(async () => ({})), delete: jest.fn(async () => undefined) } }),
        useI18n: () => ({ ...enI18n(), locale: ref('en') }), useAppToast: () => ({ success: jest.fn(), error: toastError }),
      },
    })
    const choice = app.one('[data-testid="assignee-option-u1"]')
    expect(choice).toBeDefined()
    const click = choice?.props.onClick
    expect(click).toBeInstanceOf(Function)
    ;(click as () => void)()
    await flush()
    expect(toastError).toHaveBeenCalled()
    expect(app.emitted('changed')).toHaveLength(0)
    app.unmount()
  })

  test('AC6: renders no free-text user-id assignment field', () => {
    const app = mountSfc(propertiesFile, {
      props: {
        ticket: { id: 't1', ref: 'WEB-1', title: 'Ticket', type: 'TASK', priority: 'LOW', status: 'CREATED', createdAt: '2026-01-01T00:00:00Z' },
        projectSlug: 'web', ticketRef: 'WEB-1', ticketLinks: [], allLabels: [], canWork: true, canManage: false,
      },
      components: propertyStubs,
      alias: { '~/components/TicketActionPanel.vue': { default: { render: () => null } } },
      globals: { useApi: () => ({ $api: { get: jest.fn(async () => ({})), post: jest.fn(async () => undefined), delete: jest.fn(async () => undefined) } }), useI18n: () => ({ ...enI18n(), locale: ref('en') }), useAppToast: () => ({ success: jest.fn(), error: jest.fn() }) },
    })
    expect(app.find('input').some((input) => input.props.placeholder === 'tickets.assign.userIdPlaceholder')).toBe(false)
    app.unmount()
  })
})
