import { describe, test, expect } from '@jest/globals'
import * as Vue from 'vue'
import { ref, computed, watch, nextTick } from 'vue'
import { mountSfc, webFile } from '../helpers/mount-sfc'
import { uiStubs, enI18n } from '../helpers/fleet-harness'
import { historyRows } from '../../lib/fleet-schedules'
import type { FleetJobDto } from '../../lib/fleet-types'

const history = webFile('components', 'fleet', 'ScheduleHistory.vue')

const job = (id: string, over: Partial<FleetJobDto> = {}): FleetJobDto => ({
  id, projectId: 'p1', repoId: 'r1', ref: 'main', command: 'RUN', feature: 'login', planFrom: null, profiles: [],
  maxCostUsd: '5.0000', bashMode: 'raw', selectorLabels: [], pinnedRunnerId: null, runnerId: null, leaseEpoch: 1,
  state: 'COMPLETED', stateReason: null, requestedById: 'u1', queuedAt: '2026-10-02T00:00:00.000Z', assignedAt: null,
  startedAt: null, finishedAt: null, cancelRequestedAt: null, naxRunId: null, naxLogRunId: null, naxCostRunId: null,
  progress: { total: 2, passed: 2, failed: 0, paused: 0, blocked: 0, pending: 0 }, currentStoryId: null, currentPhase: null,
  costSpentUsd: '0.9000', lastHeartbeatAt: null, finishResult: null, escalationReason: null, exitCode: null,
  resultBranch: null, resultSha: null, resultPrUrl: null, wipPush: null, stories: null, storiesTruncated: false,
  scheduleId: 's1', coalescedCount: 0, ...over,
})

function mountHistory(jobs: FleetJobDto[], oldestLoaded = true) {
  return mountSfc(history, {
    components: uiStubs,
    props: { slug: 'koda', rows: historyRows(jobs, oldestLoaded) },
    globals: { ref, computed, watch, nextTick, onMounted: Vue.onMounted, useI18n: () => enI18n() },
  })
}

const cell = (app: ReturnType<typeof mountHistory>, rowId: string, testid: string): string => {
  const row = app.find('[data-stub="tr"]').find((r) => r.props['data-testid'] === `fleet-schedule-run-${rowId}`)
  const found = row ? app.find('[data-stub="td"]', row).find((c) => c.props['data-testid'] === testid) : undefined
  return found ? app.textOf(found).trim() : '<missing>'
}

describe('FleetScheduleHistory', () => {
  test('no runs shows the empty line', () => {
    const app = mountHistory([])
    // The EmptyState stub keeps `message` as a prop (as on the budgets pages), so the copy is asserted there.
    expect(app.one('[data-stub="empty-state"]')?.props.message).toBe('No runs yet')
    expect(app.find('[data-stub="tr"]').filter((r) => String(r.props['data-testid']).startsWith('fleet-schedule-run-'))).toHaveLength(0)
    app.unmount()
  })

  test('a row: link to the job, state badge, stories with delta, cost, merged fires', () => {
    const app = mountHistory([job('j2', { coalescedCount: 2 }), job('j1', { progress: { total: 2, passed: 1, failed: 0, paused: 0, blocked: 0, pending: 1 }, state: 'FAILED' })])
    expect(cell(app, 'j2', 'fleet-schedule-run-stories')).toBe('2/2 (+1)')
    expect(cell(app, 'j1', 'fleet-schedule-run-stories')).toBe('1/2 (+1)')
    expect(cell(app, 'j2', 'fleet-schedule-run-cost')).toBe('$0.90')
    expect(cell(app, 'j2', 'fleet-schedule-run-coalesced')).toBe('2')
    const link = app.find('[data-stub="nuxt-link"]').find((l) => l.props.to === '/koda/fleet/jobs/j2')
    expect(link).toBeDefined()
    const states = app.find('[data-stub="badge"]').filter((b) => b.props['data-testid'] === 'fleet-job-state').map((b) => b.props['data-state'])
    expect(states).toEqual(['COMPLETED', 'FAILED'])
    app.unmount()
  })

  test('push outcome, budget stop and a raw reason are rendered; no progress shows "-"', () => {
    const app = mountHistory([
      job('j3', { progress: null, stateReason: 'checkout: branch diverged', wipPush: 'pushed' }),
      job('j2', { stateReason: 'budget:pol1', wipPush: 'failed:rejected' }),
    ], false)
    expect(cell(app, 'j3', 'fleet-schedule-run-stories')).toBe('-')
    expect(cell(app, 'j3', 'fleet-schedule-run-push')).toBe('Progress pushed to the branch')
    expect(cell(app, 'j3', 'fleet-schedule-run-reason')).toBe('checkout: branch diverged')
    expect(cell(app, 'j2', 'fleet-schedule-run-push')).toBe('Progress push failed: rejected')
    expect(cell(app, 'j2', 'fleet-schedule-run-reason')).toBe('Stopped by a fleet budget')
    // Oldest loaded row of a page that is not the last: no delta (Review Focus 5).
    expect(cell(app, 'j2', 'fleet-schedule-run-stories')).toBe('2/2 (-)')
    app.unmount()
  })
})
