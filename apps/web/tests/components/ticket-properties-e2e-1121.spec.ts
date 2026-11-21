import { describe, expect, test, jest } from '@jest/globals'
import { ref } from 'vue'
import { mountSfc, webFile } from '../helpers/mount-sfc'
import { enI18n, uiStubs } from '../helpers/fleet-harness'

const file = webFile('components', 'TicketProperties.vue')
const ticket = (assignee: unknown = null) => ({ id: 't1', ref: 'WEB-1', title: 'Ticket', type: 'TASK', priority: 'LOW', status: 'CREATED', createdAt: '2026-01-01T00:00:00Z', assignee, labels: [] })
function mount(over: { assignee?: unknown; labels?: Array<{ id: string; name: string; color: string }>; confirm?: () => Promise<boolean>; remove?: () => Promise<void> } = {}) {
  const toast = { success: jest.fn(), error: jest.fn() }
  const del = jest.fn(over.remove ?? (async () => undefined))
  const navigateTo = jest.fn(async () => undefined)
  const confirm = jest.fn(over.confirm ?? (async () => true))
  const app = mountSfc(file, {
    props: { ticket: ticket(over.assignee), projectSlug: 'web', ticketRef: 'WEB-1', ticketLinks: [], allLabels: over.labels ?? [], canAssign: true, canLabel: true, canUnlabel: false, canLink: false, canDelete: true },
    components: { ...uiStubs, Select: uiStubs.Button, SelectTrigger: uiStubs.Button, SelectValue: uiStubs.Button, SelectContent: uiStubs.Button, SelectItem: uiStubs.Button },
    alias: { '~/components/TicketActionPanel.vue': { render: () => null } },
    globals: { useApi: () => ({ $api: { post: jest.fn(async () => undefined), delete: del } }), useI18n: () => ({ ...enI18n(), locale: ref('en') }), useAppToast: () => toast, useConfirm: () => ({ confirm }), navigateTo },
  })
  return { app, toast, del, confirm, navigateTo }
}
const clickDelete = (app: ReturnType<typeof mountSfc>) => (app.find('[data-stub="button"]').find(node => app.textOf(node) === 'Delete Ticket')?.props.onClick as () => Promise<void>)()

describe('TicketProperties US-004', () => {
  test('AC-1: delete asks for styled confirmation details', async () => {
    const { app, confirm } = mount()
    await clickDelete(app)
    expect(confirm).toHaveBeenCalledTimes(1)
    expect(confirm).toHaveBeenCalledWith({ title: 'Delete this ticket?', body: 'The ticket is removed from the board, search and its project. This cannot be undone from the app.', confirmLabel: 'Delete Ticket', destructive: true })
    app.unmount()
  })
  test('AC-2 and AC-9: cancel performs no delete, navigation, or toast', async () => {
    const { app, del, navigateTo, toast } = mount({ confirm: async () => false })
    await clickDelete(app)
    expect(del).not.toHaveBeenCalled(); expect(navigateTo).not.toHaveBeenCalled(); expect(toast.error).not.toHaveBeenCalled(); expect(toast.success).not.toHaveBeenCalled()
    app.unmount()
  })
  test('AC-3: confirmed delete then navigates to project', async () => {
    const { app, del, navigateTo } = mount()
    await clickDelete(app)
    expect(del).toHaveBeenCalledWith('/projects/web/tickets/WEB-1')
    expect(navigateTo).toHaveBeenCalledWith('/web')
    app.unmount()
  })
  test('AC-4: failed confirmed delete reports API error and does not navigate', async () => {
    const { app, toast, navigateTo } = mount({ remove: async () => { throw Object.assign(new Error('Denied'), { data: { message: 'Denied' } }) } })
    await clickDelete(app)
    expect(toast.error).toHaveBeenCalledTimes(1); expect(toast.error).toHaveBeenCalledWith('Denied'); expect(navigateTo).not.toHaveBeenCalled()
    app.unmount()
  })
  test('AC-5: unassigned ticket has Change but no Unassign', () => {
    const { app } = mount()
    expect(app.one('[data-testid="assignee-change"]')).toBeDefined()
    expect(app.find('[data-stub="button"]').some(node => app.textOf(node) === 'Unassign')).toBe(false)
    app.unmount()
  })
  test('AC-6: assigned ticket shows Unassign', () => {
    const { app } = mount({ assignee: { kind: 'user', id: 'u2', name: 'Bob' } })
    expect(app.find('[data-stub="button"]').some(node => app.textOf(node) === 'Unassign')).toBe(true)
    app.unmount()
  })
  test('AC-7: empty project labels show management hint and no select', () => {
    const { app } = mount()
    const hint = app.one('[data-testid="ticket-labels-none"]')
    expect(hint).toBeDefined()
    expect(hint ? app.textOf(hint) : '').toContain('This project has no labels yet.')
    expect(app.find('select')).toHaveLength(0)
    const link = app.find('[data-stub="nuxt-link"]').find(node => node.props.to === '/web/labels')
    expect(link).toBeDefined()
    expect(link ? app.textOf(link) : '').toBe('Create labels')
    app.unmount()
  })
  test('AC-8: available project labels render label select without empty hint', () => {
    const { app } = mount({ labels: [{ id: 'l1', name: 'bug', color: '#123456' }] })
    expect(app.one('[data-testid="ticket-labels-none"]')).toBeUndefined()
    expect(app.one('[aria-label="Select label"]')).toBeDefined()
    app.unmount()
  })
})
