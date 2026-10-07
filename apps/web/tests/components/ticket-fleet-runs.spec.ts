import { describe, expect, test } from '@jest/globals'
import { mountSfc, webFile } from '../helpers/mount-sfc'
import { enI18n, toastRecorder, uiStubs } from '../helpers/fleet-harness'
import type { TicketFleetJobDto } from '../../lib/fleet-types'
import type { ProjectEventHandlers } from '../../lib/project-event-stream'

const card = webFile('components', 'TicketFleetRuns.vue')
const LIST = '/projects/web/tickets/WEB-1/fleet-jobs'
const wait = (ms = 0): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
/** Past the card's 300 ms live debounce. */
const settle = (): Promise<void> => wait(350)

const run = (id: string, over: Partial<TicketFleetJobDto> = {}): TicketFleetJobDto => ({
  id, command: 'RUN', feature: `feat-${id}`, state: 'COMPLETED', stateReason: null, escalationReason: null,
  resultBranch: null, resultSha: null, resultPrUrl: null, costUsd: '0.4200',
  queuedAt: '2026-10-07T00:00:00.000Z', finishedAt: '2026-10-07T00:10:00.000Z', ...over,
})

/** Each GET answers the next entry (the last one repeats); `'fail'` makes that GET throw. */
function mountCard(opts: { lists: Array<TicketFleetJobDto[] | 'fail'>; links?: unknown[]; canWork?: boolean; deleteFails?: boolean }) {
  const gets: string[] = []
  const deletes: string[] = []
  let handlers: ProjectEventHandlers | null = null
  const toast = toastRecorder()
  const api = {
    get: async (path: string) => {
      gets.push(path)
      const next = opts.lists[Math.min(gets.length - 1, opts.lists.length - 1)]
      if (next === 'fail') throw new Error('down')
      return next
    },
    delete: async (path: string) => {
      deletes.push(path)
      if (opts.deleteFails) throw Object.assign(new Error('gone'), { data: { message: 'Not linked' } })
    },
  }
  const app = mountSfc(card, {
    components: uiStubs,
    props: { projectSlug: 'web', ticketRef: 'WEB-1', ticketId: 't1', ticketLinks: opts.links ?? [], canWork: opts.canWork ?? true },
    globals: {
      useI18n: () => enI18n(),
      useAppToast: () => toast,
      useApi: () => ({ $api: api }),
      useProjectEvents: (_slug: string, h: ProjectEventHandlers) => { handlers = h },
    },
  })
  const events = (): ProjectEventHandlers => {
    if (!handlers) throw new Error('useProjectEvents was not called')
    return handlers
  }
  return { app, gets, deletes, toast, events }
}

const rowOf = (app: ReturnType<typeof mountSfc>, jobId: string) =>
  app.find('[data-testid="ticket-fleet-run"]').find((r) => r.props['data-job'] === jobId)
const inRow = (app: ReturnType<typeof mountSfc>, jobId: string, testid: string) => {
  const row = rowOf(app, jobId)
  return row ? app.find(`[data-testid="${testid}"]`, row) : []
}

describe('TicketFleetRuns (C9 §4, D461)', () => {
  test('renders nothing when the ticket has no fleet jobs', async () => {
    const { app, gets } = mountCard({ lists: [[]] })
    await wait()
    expect(gets).toEqual([LIST])
    expect(app.one('[data-testid="ticket-fleet-runs"]')).toBeUndefined()
    app.unmount()
  })

  test('a row: command, state, link to the job, branch with short sha, PR with its live state, cost', async () => {
    const pr = 'https://github.com/acme/app/pull/7'
    const { app } = mountCard({
      lists: [[run('j1', { resultBranch: 'feat/x', resultSha: 'abcdef1234567', resultPrUrl: pr })]],
      links: [{ url: pr, linkType: 'pr', prState: 'merged' }],
    })
    await wait()
    expect(app.textOf(inRow(app, 'j1', 'ticket-fleet-run-command')[0])).toBe('RUN')
    expect(inRow(app, 'j1', 'fleet-job-state')[0].props['data-state']).toBe('COMPLETED')
    expect(inRow(app, 'j1', 'ticket-fleet-run-link')[0].props.to).toBe('/web/fleet/jobs/j1')
    expect(app.textOf(inRow(app, 'j1', 'ticket-fleet-run-branch')[0])).toBe('feat/x (abcdef1)')
    expect(inRow(app, 'j1', 'ticket-fleet-run-pr-state')[0].props['data-state']).toBe('merged')
    expect(app.textOf(inRow(app, 'j1', 'ticket-fleet-run-cost')[0])).toBe('$0.42')
    expect(inRow(app, 'j1', 'ticket-fleet-run-reason')).toHaveLength(0)
    const prLink = app.find('a').find((a) => a.props.href === pr)
    expect(prLink?.props.rel).toBe('noopener noreferrer')
    app.unmount()
  })

  test('failure reasons follow the comment rule; an http PR URL is text, not a link', async () => {
    const { app } = mountCard({
      lists: [[
        run('j1', { state: 'FAILED', stateReason: 'acceptance failed' }),
        run('j2', { state: 'ESCALATED', stateReason: 's', escalationReason: 'needs a human' }),
        run('j3', { resultPrUrl: 'http://example.com/pull/1' }),
      ]],
    })
    await wait()
    expect(app.textOf(inRow(app, 'j1', 'ticket-fleet-run-reason')[0])).toBe('acceptance failed')
    expect(app.textOf(inRow(app, 'j2', 'ticket-fleet-run-reason')[0])).toBe('needs a human')
    expect(app.find('a').some((a) => a.props.href === 'http://example.com/pull/1')).toBe(false)
    expect(app.textOf(inRow(app, 'j3', 'ticket-fleet-run-pr')[0])).toContain('http://example.com/pull/1')
    app.unmount()
  })

  test('live: refetches for this ticket, a listed job, a newly queued job and a resync; not for others (P3)', async () => {
    const { app, gets, events } = mountCard({ lists: [[run('j1', { state: 'RUNNING' })]] })
    await wait()
    const fleetJob = (jobId: string, state: string) => ({ id: 'e', type: 'fleet_job' as const, projectId: 'p', jobId, state, at: '' })
    const ticketEvent = (ticketId: string) => ({ id: 'e', type: 'ticket' as const, action: 'updated' as const, projectId: 'p', ticketId, actorId: 'u', at: '' })

    events().onFleetJob?.(fleetJob('j9', 'RUNNING'))
    events().onEvent?.(ticketEvent('t2'))
    await settle()
    expect(gets).toHaveLength(1)

    events().onFleetJob?.(fleetJob('j1', 'FAILED'))
    await settle()
    expect(gets).toHaveLength(2)
    events().onFleetJob?.(fleetJob('j9', 'QUEUED'))
    await settle()
    expect(gets).toHaveLength(3)
    events().onEvent?.(ticketEvent('t1'))
    await settle()
    expect(gets).toHaveLength(4)
    events().onResync()
    await settle()
    expect(gets).toHaveLength(5)
    app.unmount()
  })

  test('a failed load keeps the rows on screen and shows no toast (P4)', async () => {
    const { app, gets, toast, events } = mountCard({ lists: [[run('j1')], 'fail'] })
    await wait()
    events().onResync()
    await settle()
    expect(gets).toHaveLength(2)
    expect(rowOf(app, 'j1')).toBeDefined()
    expect(toast.errors).toEqual([])
    app.unmount()
  })

  test('Unlink needs canWork, asks first, deletes, reloads and tells the page', async () => {
    const viewer = mountCard({ lists: [[run('j1')]], canWork: false })
    await wait()
    expect(viewer.app.find('[data-testid="ticket-fleet-run-unlink"]')).toHaveLength(0)
    viewer.app.unmount()

    const { app, gets, deletes, toast } = mountCard({ lists: [[run('j1')], []] })
    await wait()
    expect(deletes).toEqual([])
    ;(inRow(app, 'j1', 'ticket-fleet-run-unlink')[0].props.onClick as () => void)()
    await wait()
    expect(deletes).toEqual([])
    await (app.one('[data-testid="ticket-fleet-run-unlink-confirm"]')?.props.onClick as () => Promise<void>)()
    await wait()
    expect(deletes).toEqual(['/projects/web/tickets/WEB-1/fleet-jobs/j1'])
    expect(toast.successes).toEqual(['Fleet job unlinked'])
    expect(app.emitted('changed')).toHaveLength(1)
    expect(gets).toHaveLength(2)
    expect(app.one('[data-testid="ticket-fleet-runs"]')).toBeUndefined()
    app.unmount()
  })

  test('an Unlink that fails (already unlinked) toasts the API message and reloads, without "changed"', async () => {
    const { app, gets, toast } = mountCard({ lists: [[run('j1')], []], deleteFails: true })
    await wait()
    ;(inRow(app, 'j1', 'ticket-fleet-run-unlink')[0].props.onClick as () => void)()
    await wait()
    await (app.one('[data-testid="ticket-fleet-run-unlink-confirm"]')?.props.onClick as () => Promise<void>)()
    await wait()
    expect(toast.errors).toEqual(['Not linked'])
    expect(app.emitted('changed')).toHaveLength(0)
    expect(gets).toHaveLength(2)
    app.unmount()
  })
})
