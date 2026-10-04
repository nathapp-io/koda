import { afterEach, describe, expect, jest, test } from '@jest/globals'
import * as Vue from 'vue'
import { computed, nextTick, reactive, ref, watch } from 'vue'
import { mountSfc, webFile, type FakeNode } from '../helpers/mount-sfc'
import { enI18n, uiStubs } from '../helpers/fleet-harness'
import * as apiModule from '../../composables/useApi'
import { ApiError } from '../../composables/useApi'
import type { FleetJobLogEntriesDto, FleetJobLogListDto } from '../../lib/fleet-log-types'
import type { LiveFleetLogEvent, ProjectEventHandlers } from '../../lib/project-event-stream'

const pageFile = webFile('pages', '[project]', 'fleet', 'jobs', '[id]', 'logs.vue')

const page = (over: Partial<FleetJobLogEntriesDto> = {}): FleetJobLogEntriesDto => ({
  entries: [{ offset: 0, length: 40, level: 'info', message: 'started', storyId: 'US-001', stage: 'run' }],
  nextCursor: 0, scannedFrom: 0, scannedTo: 40, atEnd: true, size: 40, complete: false, truncated: false, ...over,
})
const list = (over: Partial<FleetJobLogListDto> = {}): FleetJobLogListDto => ({
  attempts: [{ leaseEpoch: 1, legacySampled: false, streams: [{ stream: 'run', sizeBytes: 40, complete: false, truncated: false, source: 'stream', expired: false, updatedAt: 'x' }] }],
  ...over,
})
const logEvent = (over: Partial<LiveFleetLogEvent> = {}): LiveFleetLogEvent => ({
  id: `e${Math.random()}`, type: 'fleet_log', projectId: 'p1', jobId: 'j1', leaseEpoch: 1, stream: 'run', size: 80, complete: false, at: 'x', ...over,
})

function mountPage(opts: { state?: string; list?: FleetJobLogListDto; entries?: Array<FleetJobLogEntriesDto | Error>; query?: Record<string, string> } = {}) {
  const route = reactive({ params: { project: 'koda', id: 'j1' }, query: { ...(opts.query ?? {}) } as Record<string, string>, fullPath: '/koda/fleet/jobs/j1/logs' })
  const replace = jest.fn(async ({ query }: { query: Record<string, string> }) => {
    route.query = query
    route.fullPath = `/koda/fleet/jobs/j1/logs?${new URLSearchParams(query).toString()}`
  })
  const answers = [...(opts.entries ?? [page()])]
  const entries = jest.fn(async (_stream: string, _query: Record<string, string>) => {
    const next = answers.shift() ?? page({ entries: [], nextCursor: 40, scannedFrom: 40, scannedTo: 40 })
    if (next instanceof Error) throw next
    return next
  })
  let handlers: ProjectEventHandlers | null = null
  const job = { id: 'j1', feature: 'login', command: 'RUN', state: opts.state ?? 'RUNNING', leaseEpoch: 1, stories: [{ id: 'US-001' }, { id: 'US-002' }] }
  const app = mountSfc(pageFile, {
    components: uiStubs,
    alias: { '~/composables/useApi': apiModule },
    globals: {
      ref, computed, watch, nextTick, onMounted: Vue.onMounted, onBeforeUnmount: Vue.onBeforeUnmount,
      definePageMeta: () => undefined,
      useRoute: () => route,
      useRouter: () => ({ replace }),
      useI18n: () => enI18n(),
      useFleetJobs: () => ({ get: jest.fn(async () => job) }),
      useFleetJobLogs: () => ({
        list: jest.fn(async () => opts.list ?? list()),
        entries,
        downloadHref: (stream: string, epoch: number) => `/api/dl/${stream}/${epoch}`,
      }),
      useProjectEvents: (_slug: string, h: ProjectEventHandlers) => { handlers = h },
    },
  })
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 6; i += 1) {
      await new Promise((resolve) => { setImmediate(resolve) })
      await nextTick()
    }
  }
  const byId = (id: string): FakeNode[] => app.find(`[data-testid="${id}"]`)
  const click = (id: string): void => (byId(id)[0].props.onClick as () => void)()
  const fire = (event: LiveFleetLogEvent): void => handlers?.onFleetLog?.(event)
  return { app, route, replace, entries, settle, byId, click, fire }
}

afterEach(() => { jest.useRealTimers() })

describe('Job logs page (spec §4.1)', () => {
  test('opens the latest attempt backward from the end and follows a running job', async () => {
    const p = mountPage()
    await p.settle()
    expect(p.entries).toHaveBeenCalledWith('run', { direction: 'backward', limit: '200', leaseEpoch: '1' })
    expect(p.app.text()).toContain('started')
    expect(p.byId('fleet-log-following')).toHaveLength(1)
    expect(p.byId('fleet-log-download')[0].props.href).toBe('/api/dl/run/1')
    p.app.unmount()
  })

  test('a fleet_log for this job, attempt and stream fetches forward from the tail; others are ignored', async () => {
    const p = mountPage({ entries: [page(), page({ entries: [{ offset: 40, length: 40, level: 'warn', message: 'later' }], nextCursor: 80, scannedFrom: 40, scannedTo: 80, size: 80 })] })
    await p.settle()
    p.fire(logEvent({ jobId: 'other' }))
    p.fire(logEvent({ stream: 'stdout' }))
    p.fire(logEvent({ leaseEpoch: 2 }))
    await p.settle()
    expect(p.entries).toHaveBeenCalledTimes(1)
    p.fire(logEvent())
    await p.settle()
    expect(p.entries).toHaveBeenLastCalledWith('run', { direction: 'forward', limit: '500', cursor: '40', leaseEpoch: '1' })
    expect(p.app.text()).toContain('later')
    p.app.unmount()
  })

  test('a tab switch and a filter change go through the URL and reopen with the new query', async () => {
    const p = mountPage({ entries: [page(), page({ entries: [{ offset: 0, length: 6, text: 'hello' }] }), page()] })
    await p.settle()
    p.click('fleet-log-tab-stdout')
    await p.settle()
    expect(p.replace).toHaveBeenLastCalledWith({ query: { stream: 'stdout' } })
    expect(p.entries).toHaveBeenLastCalledWith('stdout', { direction: 'backward', limit: '200', leaseEpoch: '1' })
    expect(p.app.text()).toContain('hello')
    ;(p.byId('fleet-log-filter-text')[0].props.onChange as (e: unknown) => void)({ target: { value: 'boom' } })
    await p.settle()
    expect(p.replace).toHaveBeenLastCalledWith({ query: { stream: 'stdout', q: 'boom' } })
    expect(p.entries).toHaveBeenLastCalledWith('stdout', { direction: 'backward', limit: '200', leaseEpoch: '1', q: 'boom' })
    p.app.unmount()
  })

  test('a filtered page with no match offers one Keep searching request per click (criterion 3)', async () => {
    const empty = page({ entries: [], nextCursor: 1000, scannedFrom: 1000, scannedTo: 3_098_152, atEnd: false, size: 3_098_152 })
    const p = mountPage({ query: { level: 'error' }, state: 'COMPLETED', entries: [empty, page({ entries: [], nextCursor: 0, scannedFrom: 0, scannedTo: 1000, atEnd: true })] })
    await p.settle()
    expect(p.app.textOf(p.byId('fleet-log-searching')[0])).toContain('Searched back to 1000 B of 3.0 MiB')
    p.click('fleet-log-keep-searching')
    await p.settle()
    expect(p.entries).toHaveBeenCalledTimes(2)
    expect(p.entries).toHaveBeenLastCalledWith('run', { direction: 'backward', limit: '200', cursor: '1000', leaseEpoch: '1', level: 'error' })
    expect(p.byId('fleet-log-searching')).toHaveLength(0)
    expect(p.byId('fleet-log-empty')).toHaveLength(1)
    p.app.unmount()
  })

  test('scrolling up turns follow off; Jump to latest reopens following', async () => {
    const p = mountPage({ entries: [page(), page()] })
    await p.settle()
    const scroller = p.byId('fleet-log-scroller')[0] as FakeNode & Record<string, number>
    Object.assign(scroller, { scrollTop: 0, clientHeight: 100, scrollHeight: 1000 })
    ;(scroller.props.onScroll as () => void)()
    await p.settle()
    expect(p.byId('fleet-log-following')).toHaveLength(0)
    p.click('fleet-log-jump')
    await p.settle()
    expect(p.entries).toHaveBeenCalledTimes(2)
    expect(p.byId('fleet-log-following')).toHaveLength(1)
    p.app.unmount()
  })

  test('a terminal job with an incomplete stream says so; an expired stream (410) shows only the expired notice', async () => {
    const incomplete = mountPage({ state: 'CRASHED' })
    await incomplete.settle()
    expect(incomplete.byId('fleet-log-notice-incomplete')).toHaveLength(1)
    expect(incomplete.byId('fleet-log-following')).toHaveLength(0)
    incomplete.app.unmount()

    const expired = mountPage({ state: 'COMPLETED', entries: [new ApiError(410, 'This log was deleted after the retention window')] })
    await expired.settle()
    expect(expired.byId('fleet-log-notice-expired')).toHaveLength(1)
    expect(expired.byId('fleet-log-notice-incomplete')).toHaveLength(0)
    expect(expired.byId('fleet-log-scroller')).toHaveLength(0)
    expired.app.unmount()
  })

  test('two attempts show a picker; choosing one puts its epoch in the URL', async () => {
    const two = list({ attempts: [
      { leaseEpoch: 2, legacySampled: false, streams: [] },
      { leaseEpoch: 1, legacySampled: true, streams: [] },
    ] })
    const p = mountPage({ list: two, entries: [page(), page()] })
    await p.settle()
    const picker = p.app.find('[data-stub="fleet-select"]').find((n) => n.props.testid === 'fleet-log-attempt') as FakeNode
    expect(picker.props['model-value']).toBe('2')
    ;(picker.props['onUpdate:modelValue'] as (v: string) => void)('1')
    await p.settle()
    expect(p.replace).toHaveBeenLastCalledWith({ query: { epoch: '1' } })
    expect(p.entries).toHaveBeenLastCalledWith('run', { direction: 'backward', limit: '200', leaseEpoch: '1' })
    expect(p.byId('fleet-log-notice-legacy')).toHaveLength(1)
    p.app.unmount()
  })
})
