import { describe, expect, test, jest } from '@jest/globals'
import { nextTick, ref } from 'vue'
import { mountSfc, webFile } from '../helpers/mount-sfc'
import { enI18n, uiStubs } from '../helpers/fleet-harness'

const file = webFile('components', 'TicketProperties.vue')
const flush = async () => { await Promise.resolve(); await nextTick(); await Promise.resolve(); await nextTick() }
const props = (canAssign = true) => ({ ticket: { id: 't1', ref: 'WEB-1', title: 'Ticket', type: 'TASK', priority: 'LOW', status: 'CREATED', createdAt: '2026-01-01T00:00:00Z' }, projectSlug: 'web', ticketRef: 'WEB-1', ticketLinks: [], allLabels: [], canAssign, canLabel: false, canUnlabel: false, canLink: false, canDelete: false })
function mount(post: () => Promise<void>, canAssign = true) {
  const toast = { success: jest.fn(), error: jest.fn() }
  const app = mountSfc(file, { props: props(canAssign), components: { ...uiStubs, Select: uiStubs.Button, SelectTrigger: uiStubs.Button, SelectValue: uiStubs.Button, SelectContent: uiStubs.Button, SelectItem: uiStubs.Button }, alias: { '~/components/TicketActionPanel.vue': { render: () => null } }, globals: { useApi: () => ({ $api: { post, get: async () => ({ items: [{ type: 'user', id: 'u1', name: 'Alice', secondary: 'alice' }] }), delete: async () => undefined } }), useI18n: () => ({ ...enI18n(), locale: ref('en') }), useAppToast: () => toast } })
  return { app, toast }
}
const click = (app: ReturnType<typeof mountSfc>, testid: string) => (app.one(`[data-testid="${testid}"]`)?.props.onClick as () => void)()

describe('TicketProperties collapsed assignee picker', () => {
  test('starts closed; Change opens and Cancel closes it', async () => {
    const { app } = mount(async () => undefined)
    const change = app.one('[data-testid="assignee-change"]')
    expect(change).toBeDefined()
    expect(change ? app.textOf(change) : '').toBe('Change')
    expect(app.one('[data-testid="assignee-search"]')).toBeUndefined()
    click(app, 'assignee-change'); await flush()
    expect(app.one('[data-testid="assignee-search"]')).toBeDefined()
    expect(app.one('[data-testid="assignee-cancel"]')).toBeDefined()
    click(app, 'assignee-cancel'); await flush()
    expect(app.one('[data-testid="assignee-search"]')).toBeUndefined()
    app.unmount()
  })
  test('closes after successful assignment', async () => {
    const { app } = mount(async () => undefined)
    click(app, 'assignee-change'); await flush()
    ;(app.one('[data-testid="assignee-option-u1"]')?.props.onClick as () => void)(); await flush()
    expect(app.one('[data-testid="assignee-search"]')).toBeUndefined()
    app.unmount()
  })
  test('stays open and reports API error after failed assignment', async () => {
    const { app, toast } = mount(async () => { throw Object.assign(new Error('nope'), { data: { message: 'Denied' } }) })
    click(app, 'assignee-change'); await flush()
    ;(app.one('[data-testid="assignee-option-u1"]')?.props.onClick as () => void)(); await flush()
    expect(app.one('[data-testid="assignee-search"]')).toBeDefined()
    expect(toast.error).toHaveBeenCalledWith('Denied')
    app.unmount()
  })
  test('hides assignment controls without permission', () => {
    const { app } = mount(async () => undefined, false)
    expect(app.one('[data-testid="assignee-change"]')).toBeUndefined()
    expect(app.one('[data-testid="assignee-search"]')).toBeUndefined()
    app.unmount()
  })
})
