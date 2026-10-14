import { describe, expect, test } from '@jest/globals'
import {
  buildThreadTimeline,
  safePrHref,
  workflowOutcomeKey,
  writeMarkerView,
} from '~/lib/thread-timeline'
import type { HandoffJobs, ThreadTimelineEntry } from '~/lib/thread-timeline'
import type { FleetJobDto } from '~/lib/fleet-types'
import type { ChatMessageDto, ThreadDetailDto, ThreadWriteResult } from '~/lib/thread-types'

/**
 * US-004 AC1-AC7: the pure timeline builder and the write-marker view.
 *
 * Anchored markers (a write at `write.at`, a job at `job.queuedAt`) go before the first message
 * created strictly later than the anchor; unanchored markers go after every message.
 */

const at = (hhmm: string): string => `2026-10-14T${hhmm}:00.000Z`

const message = (id: string, createdAt: string): ChatMessageDto => ({
  id,
  seq: 1,
  jobId: null,
  turnId: null,
  role: 'user',
  authorUserId: 'u1',
  clientMessageId: null,
  content: id,
  toolSummary: null,
  status: 'complete',
  errorReason: null,
  usage: null,
  costUsd: null,
  costSource: null,
  createdAt,
})

const thread = (over: Record<string, unknown> = {}): ThreadDetailDto => ({
  id: 'th1',
  repoId: 'r1',
  baseRef: 'main',
  feature: 'add-auth',
  title: 'Auth spec',
  createdById: 'u1',
  runnerId: 'r1',
  backend: { kind: 'native', model: 'gpt-5' },
  status: 'ACTIVE',
  archivedAt: null,
  skills: [],
  maxCostUsd: '5',
  costUsd: '0',
  tokens: null,
  specPath: '.nax/features/add-auth/prd.json',
  pendingQuestion: null,
  session: null,
  lastActivityAt: at('00:00'),
  createdAt: at('00:00'),
  activeJob: null,
  sendRefusal: null,
  writtenPaths: [],
  publishedSha: null,
  specPublished: false,
  lastWrite: null,
  handoff: { plan: null, run: null },
  ...over,
})

const job = (over: Partial<FleetJobDto> = {}): FleetJobDto => ({
  id: 'p1',
  projectId: 'p',
  repoId: 'r1',
  ref: 'feat/add-auth',
  command: 'PLAN',
  feature: 'add-auth',
  planFrom: null,
  profiles: [],
  maxCostUsd: '5',
  bashMode: 'raw',
  approvalTimeoutSec: 600,
  pendingApprovals: 0,
  selectorLabels: [],
  pinnedRunnerId: null,
  runnerId: null,
  leaseEpoch: 0,
  state: 'COMPLETED',
  stateReason: null,
  requestedById: 'u1',
  queuedAt: at('10:06'),
  assignedAt: null,
  startedAt: null,
  finishedAt: null,
  cancelRequestedAt: null,
  naxRunId: null,
  naxLogRunId: null,
  naxCostRunId: null,
  progress: null,
  currentStoryId: null,
  currentPhase: null,
  costSpentUsd: '0.1200',
  lastHeartbeatAt: null,
  finishResult: null,
  escalationReason: null,
  exitCode: null,
  resultBranch: null,
  resultSha: null,
  resultPrUrl: null,
  wipPush: null,
  stories: null,
  storiesTruncated: false,
  postRun: null,
  scheduleId: null,
  coalescedCount: 0,
  workflow: null,
  ...over,
})

const NO_JOBS: HandoffJobs = { plan: null, run: null }

const kinds = (entries: ThreadTimelineEntry[]): string[] => entries.map(entry => entry.kind)

describe('US-004 AC1-AC7: buildThreadTimeline and writeMarkerView', () => {
  test('AC-1: buildThreadTimeline of messages created at 10:00 and 10:05 and a thread whose lastWrite is a published result at 10:02 returns entries whose kinds are [message, write, message]', () => {
    const write: ThreadWriteResult = { kind: 'published', jobId: 'w1', at: at('10:02'), sha: 'abcdef1', paths: ['a.md'], ignored: [] }
    const entries = buildThreadTimeline(
      [message('m1', at('10:00')), message('m2', at('10:05'))],
      thread({ lastWrite: write }),
      NO_JOBS,
    )

    expect(kinds(entries)).toEqual(['message', 'write', 'message'])
  })

  test('AC-2: buildThreadTimeline of messages created at 10:00 and 10:05, a thread whose handoff.plan.jobId is p1, and jobs.plan with id p1 and queuedAt 10:06 returns entries whose kinds are [message, message, job]', () => {
    const entries = buildThreadTimeline(
      [message('m1', at('10:00')), message('m2', at('10:05'))],
      thread({ handoff: { plan: { jobId: 'p1', state: 'COMPLETED', stateReason: null }, run: null } }),
      { plan: job({ id: 'p1', queuedAt: at('10:06') }), run: null },
    )

    expect(kinds(entries)).toEqual(['message', 'message', 'job'])
  })

  test('AC-3: buildThreadTimeline of a thread whose handoff.run.jobId is r1 and jobs.run null returns a last entry with kind job, command RUN and job null', () => {
    const entries = buildThreadTimeline(
      [message('m1', at('10:00'))],
      thread({ handoff: { plan: null, run: { jobId: 'r1', state: 'RUNNING', stateReason: null } } }),
      NO_JOBS,
    )

    const last = entries[entries.length - 1]
    expect(last.kind).toBe('job')
    expect(last.kind === 'job' && last.command).toBe('RUN')
    expect(last.kind === 'job' && last.job).toBeNull()
  })

  test('AC-4: buildThreadTimeline of a thread whose handoff.plan.jobId is p2 and jobs.plan with id p1 returns the PLAN entry with job null', () => {
    const entries = buildThreadTimeline(
      [],
      thread({ handoff: { plan: { jobId: 'p2', state: 'RUNNING', stateReason: null }, run: null } }),
      { plan: job({ id: 'p1' }), run: null },
    )

    const plan = entries.find(entry => entry.kind === 'job' && entry.command === 'PLAN')
    expect(plan).toBeDefined()
    expect(plan && plan.kind === 'job' && plan.job).toBeNull()
  })

  test('AC-5: writeMarkerView of a published result with sha abcdef1234567, paths [a.md, b.md] and no ignored paths returns key fleet.threads.handoff.marker.published and params { sha: abcdef1, count: 2 }', () => {
    const view = writeMarkerView({
      kind: 'published',
      jobId: 'w1',
      at: at('10:02'),
      sha: 'abcdef1234567',
      paths: ['a.md', 'b.md'],
      ignored: [],
    })

    expect(view.key).toBe('fleet.threads.handoff.marker.published')
    expect(view.params).toEqual({ sha: 'abcdef1', count: 2 })
    expect(view.paths).toEqual(['a.md', 'b.md'])
    expect(view.ignored).toEqual([])
  })

  test('AC-6: writeMarkerView of a publish_failed result with reason branch_moved returns key fleet.threads.handoff.marker.publishFailedBranchMoved', () => {
    const view = writeMarkerView({ kind: 'publish_failed', jobId: 'w1', at: at('10:02'), reason: 'branch_moved' })

    expect(view.key).toBe('fleet.threads.handoff.marker.publishFailedBranchMoved')
    expect(view.params).toEqual({})
    expect(view.paths).toEqual([])
    expect(view.ignored).toEqual([])
  })

  test('AC-7: writeMarkerView of a publish_failed result with reason repo_busy returns key fleet.threads.handoff.marker.publishFailed and params { reason: repo_busy }', () => {
    const view = writeMarkerView({ kind: 'publish_failed', jobId: 'w1', at: at('10:02'), reason: 'repo_busy' })

    expect(view.key).toBe('fleet.threads.handoff.marker.publishFailed')
    expect(view.params).toEqual({ reason: 'repo_busy' })
  })
})

describe('buildThreadTimeline keys, anchors and order', () => {
  test('a message keeps its id as key, a write is keyed write:<jobId>, a job is keyed job:<jobId>', () => {
    const entries = buildThreadTimeline(
      [message('m1', at('10:00'))],
      thread({
        lastWrite: { kind: 'discarded', jobId: 'w9', at: at('10:02'), sha: 'abc1234' },
        handoff: { plan: { jobId: 'p1', state: 'COMPLETED', stateReason: null }, run: null },
      }),
      { plan: job({ id: 'p1' }), run: null },
    )

    expect(entries.map(entry => entry.key)).toEqual(['m1', 'write:w9', 'job:p1'])
  })

  test('a write with no later message goes after every message', () => {
    const entries = buildThreadTimeline(
      [message('m1', at('10:00')), message('m2', at('10:05'))],
      thread({ lastWrite: { kind: 'discarded', jobId: 'w1', at: at('10:09'), sha: 'abc1234' } }),
      NO_JOBS,
    )

    expect(kinds(entries)).toEqual(['message', 'message', 'write'])
  })

  test('markers at the same position are ordered by anchor ascending, then write before PLAN before RUN', () => {
    const entries = buildThreadTimeline(
      [message('m1', at('10:00')), message('m2', at('10:05'))],
      thread({
        lastWrite: { kind: 'discarded', jobId: 'w1', at: at('10:01'), sha: 'abc1234' },
        handoff: {
          plan: { jobId: 'p1', state: 'COMPLETED', stateReason: null },
          run: { jobId: 'r1', state: 'RUNNING', stateReason: null },
        },
      }),
      { plan: job({ id: 'p1', queuedAt: at('10:01') }), run: job({ id: 'r1', command: 'RUN', queuedAt: at('10:01') }) },
    )

    expect(entries.map(entry => entry.key)).toEqual(['m1', 'write:w1', 'job:p1', 'job:r1', 'm2'])
  })

  test('a PLAN anchored earlier than the write sorts before it at the same position', () => {
    const entries = buildThreadTimeline(
      [message('m1', at('10:00')), message('m2', at('10:05'))],
      thread({
        lastWrite: { kind: 'discarded', jobId: 'w1', at: at('10:03'), sha: 'abc1234' },
        handoff: { plan: { jobId: 'p1', state: 'COMPLETED', stateReason: null }, run: null },
      }),
      { plan: job({ id: 'p1', queuedAt: at('10:01') }), run: null },
    )

    expect(entries.map(entry => entry.key)).toEqual(['m1', 'job:p1', 'write:w1', 'm2'])
  })

  test('an unanchored RUN goes after every message, even after a write anchored in the middle', () => {
    const entries = buildThreadTimeline(
      [message('m1', at('10:00')), message('m2', at('10:05'))],
      thread({
        lastWrite: { kind: 'discarded', jobId: 'w1', at: at('10:02'), sha: 'abc1234' },
        handoff: { plan: null, run: { jobId: 'r1', state: 'QUEUED', stateReason: null } },
      }),
      NO_JOBS,
    )

    expect(entries.map(entry => entry.key)).toEqual(['m1', 'write:w1', 'm2', 'job:r1'])
  })

  test('a thread with no lastWrite and no handoff yields only the messages in their given order', () => {
    const entries = buildThreadTimeline([message('m1', at('10:05')), message('m2', at('10:00'))], thread(), NO_JOBS)

    expect(entries.map(entry => entry.key)).toEqual(['m1', 'm2'])
  })

  test('a job whose queuedAt cannot be parsed has no anchor and goes after every message', () => {
    const entries = buildThreadTimeline(
      [message('m1', at('10:00'))],
      thread({ handoff: { plan: { jobId: 'p1', state: 'COMPLETED', stateReason: null }, run: null } }),
      { plan: job({ id: 'p1', queuedAt: 'not-a-date' }), run: null },
    )

    expect(entries.map(entry => entry.key)).toEqual(['m1', 'job:p1'])
  })
})

describe('writeMarkerView for every write kind', () => {
  test('published with ignored paths carries them through', () => {
    const view = writeMarkerView({
      kind: 'published',
      jobId: 'w1',
      at: at('10:02'),
      sha: 'abcdef1234567',
      paths: ['a.md'],
      ignored: ['node_modules/x.md'],
    })

    expect(view.paths).toEqual(['a.md'])
    expect(view.ignored).toEqual(['node_modules/x.md'])
  })

  test('discarded returns the discarded key with the short sha', () => {
    const view = writeMarkerView({ kind: 'discarded', jobId: 'w1', at: at('10:02'), sha: 'abcdef1234567' })

    expect(view.key).toBe('fleet.threads.handoff.marker.discarded')
    expect(view.params).toEqual({ sha: 'abcdef1' })
    expect(view.paths).toEqual([])
  })

  test('discard_failed returns the discardFailed key with its reason', () => {
    const view = writeMarkerView({ kind: 'discard_failed', jobId: 'w1', at: at('10:02'), reason: 'repo_busy' })

    expect(view.key).toBe('fleet.threads.handoff.marker.discardFailed')
    expect(view.params).toEqual({ reason: 'repo_busy' })
  })
})

describe('workflowOutcomeKey and safePrHref', () => {
  test('the wire outcome local-only maps to the localOnly locale key; the others pass through', () => {
    expect(workflowOutcomeKey('ready')).toBe('ready')
    expect(workflowOutcomeKey('draft')).toBe('draft')
    expect(workflowOutcomeKey('local-only')).toBe('localOnly')
  })

  test('an http(s) PR URL is kept; a null, script or relative URL is not linked', () => {
    expect(safePrHref('https://github.com/acme/app/pull/9')).toBe('https://github.com/acme/app/pull/9')
    expect(safePrHref('http://example.test/pr/1')).toBe('http://example.test/pr/1')
    expect(safePrHref(null)).toBeNull()
    expect(safePrHref('javascript:alert(1)')).toBeNull()
    expect(safePrHref('/relative/pull/1')).toBeNull()
  })
})
