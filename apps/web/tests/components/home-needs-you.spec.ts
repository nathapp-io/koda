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
    id: 'a1', type: 'nax_bash_escalate', projectId: 'p1', projectSlug: 'acme', jobId: 'j1',
    requestedAt: '2026-10-06T11:00:00Z', expiresAt: null,
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

function mount(data: HomeNeedsYou) {
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
    globals: { ref, computed, useI18n: () => enI18n() },
  })
}

describe('HomeNeedsYou', () => {
  test('renders the three lists with exact totals and deep links into the owning project', () => {
    const app = mount(fixture())
    const links = app.find('[data-stub="nuxt-link"]').map((n) => String(n.props.to))
    expect(links).toContain('/acme/tickets/ACME-1')
    expect(links).toContain('/acme/fleet/approvals')
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

  test('an unscoped approval points at the admin inbox', () => {
    const app = mount(fixture({
      approvals: [{ id: 'a2', type: 'budget_override_required', projectId: null, projectSlug: null, jobId: null, requestedAt: '2026-10-06T11:00:00Z', expiresAt: null }],
    }))
    const links = app.find('[data-stub="nuxt-link"]').map((n) => String(n.props.to))
    expect(links).toContain('/admin/fleet/approvals')
    expect(app.text()).toContain('Budget override')
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
