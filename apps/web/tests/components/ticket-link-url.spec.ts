import { describe, expect, test, jest } from '@jest/globals'
import { nextTick, ref } from 'vue'
import { mountSfc, webFile } from '../helpers/mount-sfc'
import { enI18n, uiStubs } from '../helpers/fleet-harness'

const file = webFile('components', 'TicketProperties.vue')
const flush = async () => { await Promise.resolve(); await nextTick(); await Promise.resolve(); await nextTick() }
const props = () => ({ ticket: { id: 't1', ref: 'WEB-1', title: 'Ticket', type: 'TASK', priority: 'LOW', status: 'CREATED', createdAt: '2026-01-01T00:00:00Z' }, projectSlug: 'web', ticketRef: 'WEB-1', ticketLinks: [], allLabels: [], canAssign: false, canLabel: false, canUnlabel: false, canLink: true, canDelete: false })
function mount() {
  const post = jest.fn(async () => undefined)
  const components = { ...uiStubs, Select: uiStubs.Button, SelectTrigger: uiStubs.Button, SelectValue: uiStubs.Button, SelectContent: uiStubs.Button, SelectItem: uiStubs.Button }
  const app = mountSfc(file, { props: props(), components, alias: { '~/components/TicketActionPanel.vue': { render: () => null } }, globals: { useApi: () => ({ $api: { post, get: async () => ({ items: [] }), delete: async () => undefined } }), useI18n: () => ({ ...enI18n(), locale: ref('en') }), useAppToast: () => ({ success: jest.fn(), error: jest.fn() }) } })
  const input = app.find('[data-stub="input"]')[0]
  const setUrl = async (url: string) => {
    const update = input?.props['onUpdate:modelValue'] as ((value: string) => void) | undefined
    update?.(url)
    await flush()
  }
  return { app, post, input, setUrl }
}

describe('TicketProperties link URL validation', () => {
  test('AC-1: invalid non-empty URL disables Add Link and shows the inline error', async () => {
    const { app, input, setUrl } = mount()
    expect(input).toBeDefined()
    await setUrl('not a url')
    expect(app.find('[data-stub="button"]').find(button => app.textOf(button) === 'Add Link')?.props.disabled).toBe(true)
    const error = app.one('[data-testid="ticket-link-url-error"]')
    expect(error).toBeDefined()
    expect(error ? app.textOf(error) : '').toBe('Enter a full http:// or https:// URL')
    expect(error?.props.class).toContain('text-status-rejected')
    app.unmount()
  })

  test('AC-2: a full HTTPS URL enables Add Link and has no validation error', async () => {
    const { app, setUrl } = mount()
    await setUrl('https://example.com/pull/1')
    expect(app.find('[data-stub="button"]').find(button => app.textOf(button) === 'Add Link')?.props.disabled).toBe(false)
    expect(app.one('[data-testid="ticket-link-url-error"]')).toBeUndefined()
    app.unmount()
  })

  test('AC-3: submitting a valid URL posts the trimmed URL and selected link type', async () => {
    const { app, post, setUrl } = mount()
    await setUrl('https://example.com/pull/1')
    const button = app.find('[data-stub="button"]').find(candidate => app.textOf(candidate) === 'Add Link')
    ;(button?.props.onClick as (() => void) | undefined)?.()
    await flush()
    expect(post).toHaveBeenCalledWith('/projects/web/tickets/WEB-1/links', { url: 'https://example.com/pull/1', linkType: 'pr' })
    app.unmount()
  })

  test('AC-4: a blank URL disables Add Link without showing an error', () => {
    const { app } = mount()
    const button = app.find('[data-stub="button"]').find(candidate => app.textOf(candidate) === 'Add Link')
    expect(button?.props.disabled).toBe(true)
    expect(app.one('[data-testid="ticket-link-url-error"]')).toBeUndefined()
    app.unmount()
  })
})
