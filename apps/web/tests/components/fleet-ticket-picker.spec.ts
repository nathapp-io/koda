import { describe, expect, test } from '@jest/globals'
import { mountSfc, webFile } from '../helpers/mount-sfc'
import { enI18n, uiStubs } from '../helpers/fleet-harness'

const picker = webFile('components', 'fleet', 'TicketPicker.vue')
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

const page = {
  records: [
    { ref: 'WEB-12', title: 'Login fails', status: 'CREATED', id: 'x', priority: 'HIGH' },
    { ref: 'WEB-11', title: 'Old one', status: 'CLOSED' },
    { ref: 'WEB-1', title: 'Export is slow', status: 'IN_PROGRESS' },
  ],
}

function mountPicker(modelValue: string[], opts: { fail?: boolean } = {}) {
  const gets: Array<{ path: string; query: unknown }> = []
  const api = {
    get: async (path: string, init?: { query?: unknown }) => {
      gets.push({ path, query: init?.query })
      if (opts.fail) throw new Error('down')
      return page
    },
  }
  const app = mountSfc(picker, {
    components: uiStubs,
    props: { slug: 'web', modelValue, testId: 'dispatch-tickets' },
    globals: { useI18n: () => enI18n(), useApi: () => ({ $api: api }) },
  })
  return { app, gets }
}

const byTestid = (app: ReturnType<typeof mountSfc>, testid: string) =>
  app.find('[data-testid="' + testid + '"]')

describe('FleetTicketPicker (C9 §4, P1)', () => {
  test('loads 100 newest tickets once and suggests open ones only', async () => {
    const { app, gets } = mountPicker([])
    await flush()
    expect(gets).toEqual([{ path: '/projects/web/tickets', query: { size: '100' } }])
    expect(byTestid(app, 'dispatch-tickets-suggestion').map(s => s.props['data-ref'])).toEqual(['WEB-12', 'WEB-1'])
    app.unmount()
  })

  test('chosen refs show as chips with their title; a suggestion click emits the longer list', async () => {
    const { app } = mountPicker(['WEB-12'])
    await flush()
    const chips = byTestid(app, 'dispatch-tickets-item')
    expect(chips.map(c => c.props['data-ref'])).toEqual(['WEB-12'])
    expect(app.textOf(chips[0])).toContain('Login fails')
    const suggestion = byTestid(app, 'dispatch-tickets-suggestion')[0]
    ;(suggestion.props.onClick as () => void)()
    expect(app.emitted('update:modelValue')).toEqual([[['WEB-12', 'WEB-1']]])
    app.unmount()
  })

  test('Enter adds a typed ref exactly, not the first match (WEB-1 while WEB-12 is listed first)', async () => {
    const { app } = mountPicker([])
    await flush()
    const input = byTestid(app, 'dispatch-tickets-input')[0]
    ;(input.props['onUpdate:modelValue'] as (v: string) => void)('web-1')
    await flush()
    ;(input.props.onKeydown as (e: unknown) => void)({ key: 'Enter', preventDefault: () => undefined })
    expect(app.emitted('update:modelValue')).toEqual([[['WEB-1']]])
    app.unmount()
  })

  test('Enter on free text adds the first match; on no match adds nothing', async () => {
    const { app } = mountPicker([])
    await flush()
    const input = byTestid(app, 'dispatch-tickets-input')[0]
    ;(input.props['onUpdate:modelValue'] as (v: string) => void)('export')
    await flush()
    ;(input.props.onKeydown as (e: unknown) => void)({ key: 'Enter', preventDefault: () => undefined })
    ;(byTestid(app, 'dispatch-tickets-input')[0].props['onUpdate:modelValue'] as (v: string) => void)('zzz')
    await flush()
    ;(byTestid(app, 'dispatch-tickets-input')[0].props.onKeydown as (e: unknown) => void)({ key: 'Enter', preventDefault: () => undefined })
    expect(app.emitted('update:modelValue')).toEqual([[['WEB-1']]])
    app.unmount()
  })

  test('a chip remove emits the shorter list', async () => {
    const { app } = mountPicker(['WEB-12', 'WEB-1'])
    await flush()
    const remove = app.find('[data-stub="button"]').find(b => b.props['aria-label'] === 'Remove WEB-12')
    ;(remove?.props.onClick as () => void)()
    expect(app.emitted('update:modelValue')).toEqual([[['WEB-1']]])
    app.unmount()
  })

  test('a full list disables the input and says so', async () => {
    const full = Array.from({ length: 20 }, (_, i) => `WEB-${i + 100}`)
    const { app } = mountPicker(full)
    await flush()
    expect(byTestid(app, 'dispatch-tickets-input')[0].props.disabled).toBe(true)
    expect(byTestid(app, 'dispatch-tickets-full')).toHaveLength(1)
    expect(byTestid(app, 'dispatch-tickets-suggestion')).toHaveLength(0)
    app.unmount()
  })

  test('a failed load leaves typing working (no suggestions, no throw)', async () => {
    const { app } = mountPicker([], { fail: true })
    await flush()
    expect(byTestid(app, 'dispatch-tickets-suggestion')).toHaveLength(0)
    const input = byTestid(app, 'dispatch-tickets-input')[0]
    ;(input.props['onUpdate:modelValue'] as (v: string) => void)('WEB-5')
    await flush()
    ;(byTestid(app, 'dispatch-tickets-input')[0].props.onKeydown as (e: unknown) => void)({ key: 'Enter', preventDefault: () => undefined })
    expect(app.emitted('update:modelValue')).toEqual([[['WEB-5']]])
    app.unmount()
  })
})
