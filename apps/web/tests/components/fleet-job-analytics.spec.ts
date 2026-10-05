import { afterEach, describe, expect, jest, test } from '@jest/globals'
import { readFileSync } from 'node:fs'
import * as Vue from 'vue'
import { computed, ref, watch } from 'vue'
import { mountSfc, webFile } from '../helpers/mount-sfc'
import { enI18n, uiStubs } from '../helpers/fleet-harness'

const component = webFile('components', 'fleet', 'JobAnalytics.vue')

const DATA = {
  jobId: 'j1',
  ingest: { leaseEpoch: 1, status: 'done', files: { cost: 'done', metrics: 'done', review: 'done', finish: 'done' }, ingestedAt: '2026-10-05T00:00:00.000Z', error: null },
  byStage: [{ key: 'run', costUsd: '0.1200', tokens: 220 }, { key: 'review', costUsd: '0.0134', tokens: 110 }],
  byRole: [{ key: 'implementer', costUsd: '0.1200', tokens: 200 }],
  byModel: [{ key: 'm-e2e-a', costUsd: '0.1334', tokens: 330 }],
  stories: [{ leaseEpoch: 1, featureName: 'f', storyId: 'US-001', attempts: 2, firstPassSuccess: false, success: true, costUsd: '0.1334', durationMs: 1000, completedAt: null }],
  reviews: [{ leaseEpoch: 1, storyId: 'US-001', reviewer: '<b>semantic</b>', passed: false, failOpen: false, findingCount: 1, findingsBySeverity: { error: 1 }, advisoryCount: 0, at: '2026-10-05T00:00:00.000Z' }],
  liveCostUsd: '0.0000',
  ledgerCostUsd: '0.1334',
  corrected: true,
}

type Get = jest.Mock<(path: string) => Promise<unknown>>

function mount(get: Get) {
  const app = mountSfc(component, {
    props: { slug: 'koda', jobId: 'j1', reloadKey: 0 },
    components: uiStubs,
    fleetComponents: ['FleetAnalyticsBarList'],
    globals: { ref, computed, watch, onMounted: Vue.onMounted, useI18n: () => enI18n(), useApi: () => ({ $api: { get } }) },
  })
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 4; i += 1) {
      await new Promise((resolve) => { setImmediate(resolve) })
      await Vue.nextTick()
    }
  }
  const byId = (id: string) => app.find(`[data-testid="${id}"]`)
  return { app, settle, byId }
}

describe('FleetJobAnalytics (spec §5.4, D396)', () => {
  afterEach(() => jest.clearAllMocks())

  test('stays hidden until the job has an ingest row', async () => {
    const m = mount(jest.fn(async () => ({ ...DATA, ingest: null })) as Get)
    await m.settle()
    expect(m.byId('fleet-job-analytics')).toHaveLength(0)
    m.app.unmount()
  })

  test('shows the ingest status, the correction, live vs ledger, cost bars, stories and reviews', async () => {
    const get = jest.fn(async () => DATA) as Get
    const m = mount(get)
    await m.settle()
    expect(get).toHaveBeenCalledWith('/projects/koda/fleet/jobs/j1/analytics')
    expect(m.app.textOf(m.byId('fleet-job-analytics-ingest')[0])).toContain('Done')
    expect(m.byId('fleet-job-analytics-corrected')).toHaveLength(1)
    expect(m.app.textOf(m.byId('fleet-job-analytics-ledger')[0])).toBe('Live $0.0000 / ledger $0.1334')
    expect(m.byId('fleet-job-analytics-stage-row').map((r) => r.props['data-key'])).toEqual(['run', 'review'])
    expect(m.byId('fleet-job-analytics-stage-value').map((n) => m.app.textOf(n))).toEqual(['$0.1200', '$0.0134'])
    expect(m.app.textOf(m.byId('fleet-job-analytics-story')[0])).toContain('US-001')
    const review = m.app.textOf(m.byId('fleet-job-analytics-review')[0])
    expect(review).toContain('<b>semantic</b>')
    expect(review).toContain('error 1')
    m.app.unmount()
  })

  test('lists skipped files for a partial ingest and the error for a failed one; equal live and ledger say nothing', async () => {
    const partial = mount(jest.fn(async () => ({
      ...DATA, corrected: false, liveCostUsd: '0.1334',
      ingest: { ...DATA.ingest, status: 'partial', files: { cost: 'done', review: 'skipped:v3', deleted: '2026-10-01T00:00:00.000Z' } },
    })) as Get)
    await partial.settle()
    expect(partial.app.textOf(partial.byId('fleet-job-analytics-files')[0])).toBe('Skipped files: review (skipped:v3)')
    expect(partial.byId('fleet-job-analytics-corrected')).toHaveLength(0)
    expect(partial.byId('fleet-job-analytics-ledger')).toHaveLength(0)
    partial.app.unmount()

    const failed = mount(jest.fn(async () => ({ ...DATA, ingest: { ...DATA.ingest, status: 'failed', error: 'corrupt gzip' } })) as Get)
    await failed.settle()
    expect(failed.app.textOf(failed.byId('fleet-job-analytics-ingest-error')[0])).toBe('corrupt gzip')
    failed.app.unmount()
  })

  test('a failed reload keeps the section, shows an inline retry, and the retry recovers (Review Focus 5)', async () => {
    const state = { fail: false }
    const get = jest.fn(async () => { if (state.fail) throw new Error('503'); return DATA }) as Get
    const m = mount(get)
    await m.settle()
    expect(m.byId('fleet-job-analytics-retry')).toHaveLength(0)

    state.fail = true
    // The refresh button runs the same load() that a live event (reloadKey) triggers.
    m.byId('fleet-job-analytics-reload')[0].props.onClick()
    await m.settle()
    expect(m.byId('fleet-job-analytics')).toHaveLength(1)
    expect(m.byId('fleet-job-analytics-error')).toHaveLength(1)
    expect(m.byId('fleet-job-analytics-corrected')).toHaveLength(1)

    state.fail = false
    m.byId('fleet-job-analytics-retry')[0].props.onClick()
    await m.settle()
    expect(m.byId('fleet-job-analytics-error')).toHaveLength(0)
    expect(get).toHaveBeenCalledTimes(3)
    const source = readFileSync(component, 'utf-8')
    expect(source).toContain('watch(() => props.reloadKey, load)')
    expect(source).not.toContain('useAppToast')
    m.app.unmount()
  })
})
