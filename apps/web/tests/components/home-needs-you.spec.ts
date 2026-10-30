import { describe, test, expect } from '@jest/globals'
import * as Vue from 'vue'
import { ref, computed } from 'vue'
import { mountSfc, webFile } from '../helpers/mount-sfc'
import { uiStubs, enI18n } from '../helpers/fleet-harness'
import type { HomeNeedsYou } from '../../lib/home-types'

const needsYou = webFile('components', 'home', 'HomeNeedsYou.vue')

const NOW = new Date('2026-10-06T12:00:00Z')

const fixture = (over: Partial<HomeNeedsYou> = {}): HomeNeedsYou => ({
  tickets: [{
    id: 't1', projectId: 'p1', projectSlug: 'acme', ref: 'ACME-1', title: 'Fix the thing',
    type: 'BUG', status: 'IN_PROGRESS', priority: 'HIGH', updatedAt: '2026-10-06T10:00:00Z',
  }],
  ticketsTotal: 1,
  approvals: [{
    id: 'a1', permissionKey: 'fleet.job.shell.escalate', type: 'nax_bash_escalate', projectId: 'p1',
    projectSlug: 'acme', jobId: 'j1', requestedAt: '2026-10-06T11:00:00Z', expiresAt: null,
  }],
  approvalsTotal: 1,
  jobs: [{
    id: 'j1', projectId: 'p1', projectSlug: 'acme', feature: 'feat-a', command: 'RUN', state: 'FAILED',
    stateReason: null, pendingApprovals: 0, costSpentUsd: '1.5', resultPrUrl: null,
    queuedAt: '2026-10-06T09:00:00Z', finishedAt: '2026-10-06T10:30:00Z', reason: 'failed',
  }],
  jobsTotal: 1,
  ...over,
})

/** One approval row of the home card, as `GET /home` sends it. */
const approvalRow = (over: Partial<HomeNeedsYou['approvals'][number]> = {}): HomeNeedsYou['approvals'][number] => ({
  id: 'r1', permissionKey: 'label.create', type: null, projectId: null, projectSlug: null, jobId: null,
  requestedAt: '2026-10-06T11:00:00Z', expiresAt: null,
  ...over,
})

function mount(data: HomeNeedsYou, globals: Record<string, unknown> = {}) {
  return mountSfc(needsYou, {
    components: {
      ...uiStubs,
      FleetJobStateBadge: {
        name: 'StubFleetJobStateBadge',
        props: ['state'],
        setup(props: { state?: string }) {
          return () => Vue.h('x-stub-stub', { 'data-stub': 'job-state-badge' }, props.state ?? '')
        },
      },
    },
    props: { needsYou: data, now: NOW },
    globals: { ref, computed, useI18n: () => enI18n(), ...globals },
  })
}

describe('HomeNeedsYou', () => {
  test('renders the three lists with exact totals and deep links into the owning project', () => {
    const app = mount(fixture())
    const links = app.find('[data-stub="nuxt-link"]').map((n) => String(n.props.to))
    expect(links).toContain('/acme/tickets/ACME-1')
    expect(links).toContain('/acme/approvals?id=a1')
    expect(links).toContain('/acme/fleet/jobs/j1')
    const text = app.text()
    expect(text).toContain('My tickets')
    expect(text).toContain('Fix the thing')
    expect(text).toContain('IN_PROGRESS')
    expect(text).toContain('High')
    expect(text).toContain('Shell command')
    expect(text).toContain('$1.50')
    app.unmount()
  })

  test('an unscoped approval points at the global engine inbox', () => {
    const app = mount(fixture({
      approvals: [approvalRow({ id: 'a2', permissionKey: 'fleet.budget.override', type: 'budget_override_required' })],
    }))
    const links = app.find('[data-stub="nuxt-link"]').map((n) => String(n.props.to))
    expect(links).toContain('/approvals?id=a2')
    expect(app.text()).toContain('Budget override')
    app.unmount()
  })

  // P3b US-005 AC-11: a project's request opens that project's engine inbox on the row.
  test('a project approval links into the project engine inbox with the request id', () => {
    const app = mount(fixture({ approvals: [approvalRow({ projectId: 'p9', projectSlug: 'sandbox' })] }))
    const links = app.find('[data-stub="nuxt-link"]').map((n) => String(n.props.to))
    expect(links).toContain('/sandbox/approvals?id=r1')
    app.unmount()
  })

  // P3b US-005 AC-12: a request with no project opens the global engine inbox.
  test('a request without a project links into the global engine inbox with the request id', () => {
    const app = mount(fixture({ approvals: [approvalRow()] }))
    const links = app.find('[data-stub="nuxt-link"]').map((n) => String(n.props.to))
    expect(links).toContain('/approvals?id=r1')
    app.unmount()
  })

  // P3b US-005 AC-13: a request with no fleet type is labelled by its permission key.
  test('a row with no fleet type shows its permission key when the locale has no label for it', () => {
    const app = mount(
      fixture({ approvals: [approvalRow()] }),
      { useI18n: () => ({ t: enI18n().t, te: () => false }) },
    )
    expect(app.text()).toContain('label.create')
    app.unmount()
  })

  // P3b US-005 AC-15: the fleet type labels survive the new key fallback.
  test('a fleet-typed row keeps its fleet type label', () => {
    const app = mount(fixture({
      approvals: [approvalRow({ permissionKey: 'fleet.job.shell.escalate', type: 'nax_bash_escalate', projectId: 'p1', projectSlug: 'acme' })],
    }))
    expect(app.text()).toContain('Shell command')
    expect(app.text()).not.toContain('fleet.job.shell.escalate')
    app.unmount()
  })

  test('a blocked job carries the needs-approval chip with its pending count', () => {
    const app = mount(fixture({
      jobs: [{
        id: 'j2', projectId: 'p1', projectSlug: 'acme', feature: 'feat-b', command: 'RUN', state: 'QUEUED',
        stateReason: null, pendingApprovals: 2, costSpentUsd: '0', resultPrUrl: null,
        queuedAt: '2026-10-06T08:00:00Z', finishedAt: null, reason: 'blocked',
      }],
    }))
    expect(app.text()).toContain('Needs approval (2)')
    expect(app.text()).not.toContain('$')
    app.unmount()
  })

  test('everything empty reads as one quiet line, not three empty cards', () => {
    const app = mount(fixture({
      tickets: [], ticketsTotal: 0, approvals: [], approvalsTotal: 0, jobs: [], jobsTotal: 0,
    }))
    expect(app.text()).toContain('Nothing needs you right now')
    expect(app.find('nuxt-link')).toEqual([])
    app.unmount()
  })
})
