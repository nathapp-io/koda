import { describe, expect, test } from '@jest/globals'
import * as Vue from 'vue'
import { loadSfc, mountSfc, webFile } from '../helpers/mount-sfc'
import type { FakeNode, Mounted } from '../helpers/mount-sfc'
import { enI18n, i18nStub, uiStubs } from '../helpers/fleet-harness'
import type { FleetJobDto } from '~/lib/fleet-types'
import type { ThreadHandoffJob } from '~/lib/thread-types'

/**
 * US-004 AC-8 to AC-12 and the null-detail degrade (C3-R3): ThreadJobCard shows a PLAN or RUN
 * from the thread's handoff and, when the job detail is loaded, its outcome, cost and PR.
 */

const cardFile = webFile('components', 'fleet', 'threads', 'ThreadJobCard.vue')
const badgeFile = webFile('components', 'fleet', 'FleetJobStateBadge.vue')

// `NuxtLink` renders its `to` as `href`, so the link's target is observable on the fake tree.
const linkStub = {
  name: 'StubNuxtLink',
  props: ['to'],
  setup(props: { to: string }, { slots, attrs }: { slots: Record<string, (() => unknown) | undefined>; attrs: Record<string, unknown> }) {
    return () => Vue.h('a', { ...attrs, href: props.to }, slots.default?.() as Vue.VNodeChild)
  },
}

const handoff = (over: Partial<ThreadHandoffJob> = {}): ThreadHandoffJob => ({
  jobId: 'r1',
  state: 'RUNNING',
  stateReason: null,
  ...over,
})

const job = (over: Partial<FleetJobDto> = {}): FleetJobDto => ({
  id: 'r1',
  projectId: 'p1',
  repoId: 'r1',
  ref: 'feat/add-auth',
  command: 'RUN',
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
  queuedAt: '2026-10-14T10:06:00.000Z',
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
  costSpentUsd: '1.2500',
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

interface CardProps {
  command: 'PLAN' | 'RUN'
  handoff: ThreadHandoffJob
  job: FleetJobDto | null
  slug: string
}

function mountCard(props: CardProps, useI18n: () => unknown = () => i18nStub()): Mounted {
  return mountSfc(cardFile, {
    props,
    components: {
      ...uiStubs,
      NuxtLink: linkStub,
      FleetJobStateBadge: loadSfc(badgeFile, { useI18n }),
    },
    globals: { useI18n },
  })
}

/** The first element with an `href` the card rendered (the link to the job, or the PR). */
const hrefOf = (app: Mounted, testId: string): string | undefined => {
  const found = app.find(`[data-testid="${testId}"]`)[0]
  return found?.props.href as string | undefined
}

const attr = (node: FakeNode | undefined, name: string): unknown => node?.props[name]

describe('US-004 ThreadJobCard', () => {
  test('AC-8: a RUN card with a draft workflow outcome renders thread-job-card-outcome with the text of fleet.jobs.workflow.outcome.draft', () => {
    const app = mountCard(
      {
        command: 'RUN',
        handoff: handoff(),
        job: job({ workflow: { runId: 'run1', outcome: 'draft', workflowPassed: false, reasons: [], openItems: [] } }),
        slug: 'web',
      },
      () => enI18n(),
    )

    const outcome = app.one('[data-testid="thread-job-card-outcome"]')
    expect(outcome).toBeDefined()
    expect(app.textOf(outcome as FakeNode)).toBe('Draft')
  })

  test('AC-9: a RUN card whose resultPrUrl is https://github.com/acme/app/pull/9 renders thread-job-card-pr with that href', () => {
    const app = mountCard({
      command: 'RUN',
      handoff: handoff(),
      job: job({ resultPrUrl: 'https://github.com/acme/app/pull/9' }),
      slug: 'web',
    })

    expect(hrefOf(app, 'thread-job-card-pr')).toBe('https://github.com/acme/app/pull/9')
  })

  test('AC-10: a RUN card with a non-null resultPrUrl renders thread-job-card-pr with target _blank and rel noopener noreferrer', () => {
    const app = mountCard({
      command: 'RUN',
      handoff: handoff(),
      job: job({ resultPrUrl: 'https://github.com/acme/app/pull/9' }),
      slug: 'web',
    })

    const pr = app.one('[data-testid="thread-job-card-pr"]')
    expect(attr(pr, 'rel')).toBe('noopener noreferrer')
    expect(attr(pr, 'target')).toBe('_blank')
  })

  test('AC-11: a RUN card with job null and handoff FAILED renders the text of fleet.state.FAILED from the handoff state', () => {
    const app = mountCard(
      {
        command: 'RUN',
        handoff: handoff({ state: 'FAILED', stateReason: 'no prd.json produced' }),
        job: null,
        slug: 'web',
      },
      () => enI18n(),
    )

    expect(app.text()).toContain('Failed')
    expect(app.one('[data-testid="thread-job-card-reason"]')).toBeDefined()
    expect(app.text()).toContain('no prd.json produced')
    expect(app.find('[data-testid="thread-job-card-outcome"]')).toEqual([])
  })

  test('AC-12: a card with slug web and handoff jobId r1 renders thread-job-card-link with href /web/fleet/jobs/r1', () => {
    const app = mountCard({ command: 'RUN', handoff: handoff({ jobId: 'r1' }), job: null, slug: 'web' })

    expect(hrefOf(app, 'thread-job-card-link')).toBe('/web/fleet/jobs/r1')
  })
})

describe('US-004 ThreadJobCard details (C3-R3)', () => {
  test('the card title is the PLAN title for a PLAN command and the RUN title for a RUN', () => {
    expect(mountCard({ command: 'PLAN', handoff: handoff(), job: null, slug: 'web' }).text()).toContain('fleet.threads.handoff.card.plan')
    expect(mountCard({ command: 'RUN', handoff: handoff(), job: null, slug: 'web' }).text()).toContain('fleet.threads.handoff.card.run')
  })

  test('the card carries data-testid thread-job-card and data-command with its command', () => {
    const app = mountCard({ command: 'PLAN', handoff: handoff(), job: null, slug: 'web' })

    const card = app.one('[data-testid="thread-job-card"]')
    expect(card).toBeDefined()
    expect(attr(card, 'data-command')).toBe('PLAN')
  })

  test('with a loaded job the card shows the job cost through usd()', () => {
    const app = mountCard({ command: 'PLAN', handoff: handoff(), job: job({ costSpentUsd: '1.2500' }), slug: 'web' })

    expect(app.text()).toContain('$1.2500')
  })

  test('a RUN card with a job whose workflow is null shows no outcome badge', () => {
    const app = mountCard({ command: 'RUN', handoff: handoff(), job: job({ workflow: null }), slug: 'web' })

    expect(app.find('[data-testid="thread-job-card-outcome"]')).toEqual([])
  })

  test('a local-only RUN outcome maps to the localOnly label', () => {
    const app = mountCard(
      {
        command: 'RUN',
        handoff: handoff(),
        job: job({ workflow: { runId: 'run1', outcome: 'local-only', workflowPassed: true, reasons: [], openItems: [] } }),
        slug: 'web',
      },
      () => enI18n(),
    )

    expect(app.textOf(app.one('[data-testid="thread-job-card-outcome"]') as FakeNode)).toBe('Local only')
  })

  test('the workflow reasons render as their own list when the workflow is present', () => {
    const app = mountCard(
      {
        command: 'RUN',
        handoff: handoff(),
        job: job({ workflow: { runId: 'run1', outcome: 'draft', workflowPassed: false, reasons: ['tests failed'], openItems: [] } }),
        slug: 'web',
      },
      () => enI18n(),
    )

    expect(app.text()).toContain('tests failed')
  })

  test('a RUN card with no resultPrUrl shows no PR link', () => {
    const app = mountCard({ command: 'RUN', handoff: handoff(), job: job({ resultPrUrl: null }), slug: 'web' })

    expect(app.find('[data-testid="thread-job-card-pr"]')).toEqual([])
  })

  test('a non-http PR URL is not rendered as a link', () => {
    const app = mountCard({ command: 'RUN', handoff: handoff(), job: job({ resultPrUrl: 'javascript:alert(1)' }), slug: 'web' })

    expect(app.find('[data-testid="thread-job-card-pr"]')).toEqual([])
  })

  test('an ESCALATED RUN shows the needsYou line with the escalation reason', () => {
    const app = mountCard(
      {
        command: 'RUN',
        handoff: handoff({ state: 'ESCALATED' }),
        job: job({ state: 'ESCALATED', escalationReason: 'bash approval denied' }),
        slug: 'web',
      },
      () => enI18n(),
    )

    expect(app.text()).toContain('Needs you')
    expect(app.text()).toContain('bash approval denied')
  })

  test('a card whose job detail failed shows the handoff state and reason, with no PR, outcome or cost', () => {
    const app = mountCard(
      { command: 'RUN', handoff: handoff({ state: 'RUNNING', stateReason: null }), job: null, slug: 'web' },
      () => enI18n(),
    )

    expect(app.text()).toContain('Running')
    expect(app.find('[data-testid="thread-job-card-pr"]')).toEqual([])
    expect(app.find('[data-testid="thread-job-card-outcome"]')).toEqual([])
    expect(app.find('[data-testid="thread-job-card-reason"]')).toEqual([])
  })

  test('a loaded job state wins over the handoff state for the badge', () => {
    const app = mountCard(
      { command: 'RUN', handoff: handoff({ state: 'QUEUED' }), job: job({ state: 'COMPLETED' }), slug: 'web' },
      () => enI18n(),
    )

    const badge = app.find('[data-testid="fleet-job-state"]')[0]
    expect(attr(badge, 'data-state')).toBe('COMPLETED')
  })
})
