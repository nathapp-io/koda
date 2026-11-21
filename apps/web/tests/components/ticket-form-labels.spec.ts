import { describe, expect, test } from '@jest/globals'
import { nextTick } from 'vue'
import { mountSfc, webFile } from '../helpers/mount-sfc'
import { enI18n, uiStubs } from '../helpers/fleet-harness'

const flush = async () => { await Promise.resolve(); await nextTick(); await Promise.resolve(); await nextTick() }
const clickAction = (app: ReturnType<typeof mountSfc>) => (app.find('[data-stub="button"]')[0]?.props.onClick as (() => void) | undefined)?.()
const globals = { useI18n: () => enI18n(), useAppToast: () => ({ success: () => undefined, error: () => undefined }), useApi: () => ({ $api: { post: async () => undefined } }) }

describe('ticket form labels', () => {
  test('AC-1: Verify dialog shows the required-comment hint', async () => {
    const app = mountSfc(webFile('components', 'TicketActionPanel.vue'), {
      props: { ticket: { id: 't1', ref: 'WEB-1', status: 'CREATED', allowedActions: ['verify'] }, projectSlug: 'web' },
      components: uiStubs,
      globals,
    })
    clickAction(app)
    await flush()
    const hint = app.one('[data-testid="ticket-action-comment-hint"]')
    expect(hint).toBeDefined()
    expect(hint ? app.textOf(hint) : '').toBe('A comment is required to continue.')
    app.unmount()
  })

  test('AC-2: Verify dialog labels its comment textarea', async () => {
    const app = mountSfc(webFile('components', 'TicketActionPanel.vue'), {
      props: { ticket: { id: 't1', ref: 'WEB-1', status: 'CREATED', allowedActions: ['verify'] }, projectSlug: 'web' },
      components: uiStubs,
      globals,
    })
    clickAction(app); await flush()
    expect(app.find('[data-stub="label"]').some(label => label.props.for === 'ticket-action-comment' && app.textOf(label) === 'Comment')).toBe(true)
    expect(app.one('[id="ticket-action-comment"]')?.props['data-stub']).toBe('textarea')
    app.unmount()
  })

  test('AC-3: Verify comment textarea exposes required and hint ARIA attributes', async () => {
    const app = mountSfc(webFile('components', 'TicketActionPanel.vue'), {
      props: { ticket: { id: 't1', ref: 'WEB-1', status: 'CREATED', allowedActions: ['verify'] }, projectSlug: 'web' },
      components: uiStubs,
      globals,
    })
    clickAction(app); await flush()
    const textarea = app.one('[id="ticket-action-comment"]')
    expect(textarea?.props['aria-required']).toBe('true')
    expect(textarea?.props['aria-describedby']).toBe('ticket-action-comment-hint')
    app.unmount()
  })

  test('AC-4: Confirm stays disabled for blank comment and enables after text is entered', async () => {
    const app = mountSfc(webFile('components', 'TicketActionPanel.vue'), {
      props: { ticket: { id: 't1', ref: 'WEB-1', status: 'CREATED', allowedActions: ['verify'] }, projectSlug: 'web' },
      components: uiStubs,
      globals,
    })
    clickAction(app); await flush()
    const confirm = app.find('[data-stub="button"]').find(button => app.textOf(button) === 'Confirm')
    expect(confirm?.props.disabled).toBe(true)
    const textarea = app.one('[id="ticket-action-comment"]')
    ;(textarea?.props['onUpdate:modelValue'] as ((value: string) => void) | undefined)?.('ok')
    await flush()
    expect(app.find('[data-stub="button"]').find(button => app.textOf(button) === 'Confirm')?.props.disabled).not.toBe(true)
    app.unmount()
  })

  test('AC-5: Create Ticket title label is paired with its input', () => {
    const app = mountCreateTicket()
    expect(app.find('[data-stub="form-label"]').some(label => label.props.for === 'create-ticket-title')).toBe(true)
    expect(app.one('[id="create-ticket-title"]')?.props['data-stub']).toBe('input')
    app.unmount()
  })

  test('AC-6: Create Ticket type label is paired with its native select', () => {
    const app = mountCreateTicket()
    expect(app.find('[data-stub="form-label"]').some(label => label.props.for === 'create-ticket-type')).toBe(true)
    expect(app.one('[id="create-ticket-type"]')?.tag).toBe('select')
    app.unmount()
  })

  test('AC-7: Create Ticket priority label is paired with its native select', () => {
    const app = mountCreateTicket()
    expect(app.find('[data-stub="form-label"]').some(label => label.props.for === 'create-ticket-priority')).toBe(true)
    expect(app.one('[id="create-ticket-priority"]')?.tag).toBe('select')
    app.unmount()
  })

  test('AC-8: Create Ticket description label is paired with the MarkdownEditor id', () => {
    const app = mountCreateTicket()
    expect(app.find('[data-stub="form-label"]').some(label => label.props.for === 'create-ticket-description')).toBe(true)
    expect(app.one('[data-stub="markdown-editor"]')?.props.id).toBe('create-ticket-description')
    app.unmount()
  })
})

function mountCreateTicket() {
  return mountSfc(webFile('components', 'CreateTicketDialog.vue'), {
    props: { open: true, projectSlug: 'web' },
    components: Object.fromEntries(Object.entries(uiStubs).filter(([name]) => name !== 'FleetNativeSelect')),
    fleetComponents: ['FleetNativeSelect'],
    alias: { '~/components/MarkdownEditor.vue': { __esModule: true, default: { name: 'MarkdownEditorStub', template: '<div data-stub="markdown-editor" :id="$attrs.id" />' } } },
    globals: { ...globals, useForm: undefined },
  })
}
