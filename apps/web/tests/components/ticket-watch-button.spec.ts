import { describe, expect, jest, test } from '@jest/globals'
import * as Vue from 'vue'
import { ref } from 'vue'
import { readFileSync } from 'fs'
import { join } from 'path'
import { mountSfc, webFile } from '../helpers/mount-sfc'
import { enI18n, toastRecorder, uiStubs } from '../helpers/fleet-harness'
import type { WatchStateDto } from '~/lib/notification-types'

const component = webFile('components', 'TicketWatchButton.vue')

function mount(initial: WatchStateDto | null, opts: { load?: jest.Mock; toggle?: jest.Mock } = {}) {
  const state = ref<WatchStateDto | null>(null)
  const fake = {
    state, busy: ref(false),
    load: opts.load ?? jest.fn(async () => { state.value = initial }),
    toggle: opts.toggle ?? jest.fn(async () => {
      state.value = state.value ? { watching: !state.value.watching, count: state.value.count + (state.value.watching ? -1 : 1) } : null
    }),
  }
  const calls: unknown[][] = []
  const toast = toastRecorder()
  const app = mountSfc(component, {
    components: uiStubs,
    props: { projectSlug: 'koda', ticketRef: 'KODA-1' },
    alias: { '~/composables/useTicketWatch': { useTicketWatch: (...args: unknown[]) => { calls.push(args); return fake } } },
    globals: { useI18n: () => enI18n(), useAppToast: () => toast },
  })
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 4; i += 1) {
      await new Promise((resolve) => { setImmediate(resolve) })
      await Vue.nextTick()
    }
  }
  const byId = (id: string) => app.find(`[data-testid="${id}"]`)
  return { app, fake, calls, toast, settle, byId }
}

describe('TicketWatchButton (S4a §5)', () => {
  test('loads the state for this ticket and shows Watch with the count', async () => {
    const m = mount({ watching: false, count: 2 })
    await m.settle()
    expect(m.calls).toEqual([['koda', 'KODA-1']])
    expect(m.app.textOf(m.byId('ticket-watch-toggle')[0])).toContain('Watch')
    expect(m.byId('ticket-watch-toggle')[0].props['aria-pressed']).toBe('false')
    expect(m.app.textOf(m.byId('ticket-watch-count')[0])).toBe('2 watching')
  })

  test('clicking toggles to Unwatch', async () => {
    const m = mount({ watching: false, count: 2 })
    await m.settle()
    ;(m.byId('ticket-watch-toggle')[0].props.onClick as () => void)()
    await m.settle()
    expect(m.fake.toggle).toHaveBeenCalledTimes(1)
    expect(m.app.textOf(m.byId('ticket-watch-toggle')[0])).toContain('Unwatch')
    expect(m.app.textOf(m.byId('ticket-watch-count')[0])).toBe('3 watching')
  })

  test('a failed toggle tells the user', async () => {
    const m = mount({ watching: true, count: 1 }, { toggle: jest.fn(async () => { throw new Error('x') }) })
    await m.settle()
    ;(m.byId('ticket-watch-toggle')[0].props.onClick as () => void)()
    await m.settle()
    expect(m.toast.errors).toEqual(['Could not update watching'])
  })

  test('a failed load renders nothing (the ticket page stays usable)', async () => {
    const m = mount(null, { load: jest.fn(async () => { throw new Error('403') }) })
    await m.settle()
    expect(m.byId('ticket-watch-toggle')).toHaveLength(0)
  })

  test('the ticket page mounts it above the properties rail', () => {
    const source = readFileSync(join(__dirname, '../../pages/[project]/tickets/[ref].vue'), 'utf-8')
    expect(source).toContain("import TicketWatchButton from '~/components/TicketWatchButton.vue'")
    const button = source.indexOf('<TicketWatchButton :project-slug="slug" :ticket-ref="ref"')
    expect(button).toBeGreaterThan(-1)
    expect(button).toBeLessThan(source.indexOf('<TicketProperties'))
  })
})
