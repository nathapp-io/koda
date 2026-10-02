import { describe, test, expect, afterEach, jest } from '@jest/globals'
import * as Vue from 'vue'
import { ref, computed, watch, nextTick } from 'vue'
import { mountSfc, webFile } from '../helpers/mount-sfc'
import { uiStubs, enI18n } from '../helpers/fleet-harness'
import type { BudgetPolicyDto } from '../../lib/fleet-types'

const banner = webFile('components', 'fleet', 'BudgetBanner.vue')

const policy = (id: string, over: Partial<BudgetPolicyDto> = {}): BudgetPolicyDto => ({
  id, scopeType: 'global', scopeId: null, projectId: null, windowKind: 'calendar_month_utc', amountUsd: '5.0000',
  warnPercent: 80, hardStop: true, runningJobs: 'finish', paused: false, pausedAt: null,
  windowStart: '2026-10-01T00:00:00.000Z', spentUsd: '1.0000', warnReached: false, updatedById: 'u1',
  createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z', ...over,
})

const NuxtLink = {
  name: 'StubNuxtLink',
  props: ['to'],
  setup(props: { to?: string }, { slots, attrs }: { slots: { default?: () => unknown }; attrs: Record<string, unknown> }) {
    return () => Vue.h('x-stub-stub', { ...attrs, 'data-stub': 'nuxt-link', to: props.to }, slots.default?.() as never)
  },
}

function mountBanner(get: jest.Mock, props: Record<string, unknown> = {}) {
  (globalThis as Record<string, unknown>).useApi = () => ({ $api: { get } })
  let task: () => Promise<void> = async () => undefined
  const polling = { start: jest.fn(), stop: jest.fn(), runNow: async (): Promise<void> => { await task() }, isActive: () => true }
  const app = mountSfc(banner, {
    components: { ...uiStubs, NuxtLink },
    props: { slug: 'koda', ...props },
    globals: {
      ref, computed, watch, nextTick,
      onMounted: Vue.onMounted,
      onBeforeUnmount: Vue.onBeforeUnmount,
      useI18n: () => enI18n(),
      useApi: () => ({ $api: { get } }),
      useVisiblePolling: (fn: () => Promise<void>) => {
        task = fn
        return polling
      },
    },
  })
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 4; i += 1) {
      await new Promise((resolve) => { setImmediate(resolve) })
      await Vue.nextTick()
    }
  }
  return { app, polling, settle, lines: () => app.find('[data-testid="fleet-budget-banner-line"]') }
}

afterEach(() => { delete (globalThis as Record<string, unknown>).useApi })

describe('FleetBudgetBanner', () => {
  test('loads the project list and shows paused before warning, each with scope, spend and amount', async () => {
    const get = jest.fn(async () => [
      policy('w', { scopeType: 'repo', scopeId: 'r1', warnReached: true, spentUsd: '4.2500' }),
      policy('p', { paused: true, spentUsd: '6.0000', warnReached: true }),
    ])
    const m = mountBanner(get, { repoName: (id: string) => (id === 'r1' ? 'acme/app' : id) })
    await m.settle()

    expect(get).toHaveBeenCalledWith('/projects/koda/fleet/budgets')
    expect(m.lines().map((l) => [l.props['data-policy'], l.props['data-status']])).toEqual([['p', 'paused'], ['w', 'warning']])
    expect(m.app.textOf(m.lines()[0])).toBe('Fleet budget paused for the whole fleet: $6.00 of $5.00 spent. New jobs are refused until it is resumed.')
    expect(m.app.textOf(m.lines()[1])).toBe('Fleet budget for repo acme/app is at 85% ($4.25 of $5.00).')
    m.app.unmount()
  })

  test('links to the project budgets page', async () => {
    const m = mountBanner(jest.fn(async () => [policy('p', { paused: true })]))
    await m.settle()
    const link = m.app.find('[data-testid="fleet-budget-banner-link"]')
    expect(link).toHaveLength(1)
    expect(link[0].props.to).toBe('/koda/fleet/budgets')
    expect(m.app.textOf(link[0])).toBe('View budgets')
    m.app.unmount()
  })

  test('nothing flagged renders nothing (Review Focus 5)', async () => {
    const m = mountBanner(jest.fn(async () => [policy('ok'), policy('ok2', { scopeId: 'x', scopeType: 'project' })]))
    await m.settle()
    expect(m.app.find('[data-testid="fleet-budget-banner"]')).toHaveLength(0)
    m.app.unmount()
  })

  test('a failed load renders nothing and does not throw', async () => {
    const m = mountBanner(jest.fn(async () => { throw new Error('down') }))
    await m.settle()
    expect(m.app.find('[data-testid="fleet-budget-banner"]')).toHaveLength(0)
    m.app.unmount()
  })

  test('more than three flagged policies show three lines and a count of the rest', async () => {
    const rows = ['a', 'b', 'c', 'd', 'e'].map((id, i) => policy(id, { scopeType: 'repo', scopeId: `r${i}`, paused: i < 2, warnReached: true }))
    const m = mountBanner(jest.fn(async () => rows))
    await m.settle()

    expect(m.lines()).toHaveLength(3)
    const more = m.app.find('[data-testid="fleet-budget-banner-more"]')
    expect(m.app.textOf(more[0])).toBe('and 2 more')
    m.app.unmount()
  })

  test('a paused policy that is also past its warn threshold is one line', async () => {
    const m = mountBanner(jest.fn(async () => [policy('p', { paused: true, warnReached: true })]))
    await m.settle()
    expect(m.lines()).toHaveLength(1)
    m.app.unmount()
  })

  test('a repo the page does not know shows its raw id', async () => {
    const m = mountBanner(jest.fn(async () => [policy('p', { scopeType: 'repo', scopeId: 'gone', paused: true })]))
    await m.settle()
    expect(m.app.textOf(m.lines()[0])).toContain('repo gone')
    m.app.unmount()
  })

  test('polls on its own every 30 seconds', async () => {
    const m = mountBanner(jest.fn(async () => []))
    await m.settle()
    expect(m.polling.start).toHaveBeenCalled()
    m.app.unmount()
    expect(m.polling.stop).toHaveBeenCalled()
  })
})
