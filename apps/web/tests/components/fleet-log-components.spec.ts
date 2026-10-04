import { describe, expect, test } from '@jest/globals'
import { computed, nextTick, ref } from 'vue'
import { mountSfc, webFile } from '../helpers/mount-sfc'
import { enI18n, uiStubs } from '../helpers/fleet-harness'
import { EMPTY_LOG_FILTERS, type LogFilters } from '../../lib/fleet-log-query'
import type { FleetJobLogEntryDto } from '../../lib/fleet-log-types'
import type { LogNotice } from '../../lib/fleet-log-view'

const globals = { ref, computed, useI18n: () => enI18n() }

describe('FleetLogRows (spec §4.1)', () => {
  const rows: FleetJobLogEntryDto[] = [
    { offset: 0, length: 120, timestamp: '2026-10-04T10:11:12.000Z', level: 'warn', stage: 'verify', storyId: 'US-002', sessionRole: 'implementer', message: 'tests failed', data: { failed: 3 } },
    { offset: 120, length: 40, level: 'info', message: 'no data here' },
    { offset: 160, length: 30, unparsed: true, text: 'not json at all' },
    { offset: 190, length: 1_048_576, unparsed: true, truncatedLine: true, text: 'x'.repeat(20) },
  ]
  const mount = (stream: string, list: FleetJobLogEntryDto[] = rows) =>
    mountSfc(webFile('components', 'fleet', 'FleetLogRows.vue'), { props: { stream, rows: list }, globals, components: uiStubs })

  test('a run entry shows level, stage, story, role and message; data opens on click', async () => {
    const m = mount('run')
    const first = m.find('[data-testid="fleet-log-row"]')[0]
    const text = m.textOf(first)
    for (const part of ['WARN', '[verify]', '[US-002]', 'implementer', 'tests failed']) expect(text).toContain(part)
    expect(m.find('[data-testid="fleet-log-data"]')).toHaveLength(0)
    const entry = m.find('[data-testid="fleet-log-entry"]')[0]
    ;(entry.props.onClick as () => void)()
    await nextTick()
    expect(m.textOf(m.find('[data-testid="fleet-log-data"]')[0])).toContain('"failed": 3')
    ;(entry.props.onClick as () => void)()
    await nextTick()
    expect(m.find('[data-testid="fleet-log-data"]')).toHaveLength(0)
    m.unmount()
  })

  test('an entry without data cannot be expanded', () => {
    const m = mount('run')
    expect(m.find('[data-testid="fleet-log-entry"]')[1].props.disabled).toBe(true)
    m.unmount()
  })

  test('unparsed run lines are tagged, a cut line says so', () => {
    const m = mount('run')
    expect(m.find('[data-testid="fleet-log-unparsed"]')).toHaveLength(2)
    expect(m.find('[data-testid="fleet-log-cut"]')).toHaveLength(1)
    expect(m.text()).toContain('not json at all')
    m.unmount()
  })

  test('stdout lines are plain text with no unparsed tag', () => {
    const m = mount('stdout', [{ offset: 0, length: 6, text: 'hello' }])
    expect(m.textOf(m.find('[data-testid="fleet-log-text"]')[0])).toBe('hello')
    expect(m.find('[data-testid="fleet-log-unparsed"]')).toHaveLength(0)
    m.unmount()
  })

  test('markup in a log line is text, never HTML (escape all log text)', () => {
    const hostile = '<img src=x onerror=alert(1)>'
    const m = mount('stdout', [{ offset: 0, length: 30, text: hostile }])
    expect(m.find('img')).toHaveLength(0)
    expect(m.text()).toContain(hostile)
    m.unmount()
  })
})

describe('FleetLogFilters (spec §4.1)', () => {
  function mount(stream: string, filters: LogFilters = EMPTY_LOG_FILTERS) {
    const updates: LogFilters[] = []
    const m = mountSfc(webFile('components', 'fleet', 'FleetLogFilters.vue'), {
      props: { stream, filters, stories: ['US-001', 'US-002'], onUpdate: (f: LogFilters) => updates.push(f) },
      globals, components: uiStubs,
    })
    const fire = (id: string, value: string) => (m.find(`[data-testid="${id}"]`)[0].props.onChange as (e: unknown) => void)({ target: { value } })
    const pick = (value: string) => (m.find('[data-stub="fleet-select"]')[0].props['onUpdate:modelValue'] as (v: string) => void)(value)
    return { m, updates, fire, pick }
  }

  test('the run stream offers level, story (with suggestions), stage, role and text', () => {
    const { m } = mount('run')
    expect(m.find('[data-stub="fleet-select"]')[0].props.testid).toBe('fleet-log-filter-level')
    for (const id of ['story', 'stage', 'role', 'text']) expect(m.find(`[data-testid="fleet-log-filter-${id}"]`)).toHaveLength(1)
    expect(m.find('option').map((o) => o.props.value)).toEqual(expect.arrayContaining(['US-001', 'US-002']))
    m.unmount()
  })

  test('stdout/stderr offer text only', () => {
    const { m } = mount('stderr')
    expect(m.find('[data-testid="fleet-log-filter-text"]')).toHaveLength(1)
    expect(m.find('[data-stub="fleet-select"]')).toHaveLength(0)
    expect(m.find('[data-testid="fleet-log-filter-story"]')).toHaveLength(0)
    m.unmount()
  })

  test('a changed field emits the whole filter set once, trimmed; an unchanged value emits nothing', () => {
    const { m, updates, fire, pick } = mount('run')
    fire('fleet-log-filter-story', ' US-002 ')
    fire('fleet-log-filter-stage', '')
    pick('warn')
    expect(updates).toEqual([{ ...EMPTY_LOG_FILTERS, storyId: 'US-002' }, { ...EMPTY_LOG_FILTERS, level: 'warn' }])
    m.unmount()
  })

  test('Clear shows only with an active filter and emits empty filters', () => {
    const plain = mount('run')
    expect(plain.m.find('[data-testid="fleet-log-filter-clear"]')).toHaveLength(0)
    plain.m.unmount()
    const { m, updates } = mount('run', { ...EMPTY_LOG_FILTERS, q: 'boom' })
    ;(m.find('[data-testid="fleet-log-filter-clear"]')[0].props.onClick as () => void)()
    expect(updates).toEqual([EMPTY_LOG_FILTERS])
    m.unmount()
  })
})

describe('FleetLogNotices (spec §4.1)', () => {
  const mount = (notices: LogNotice[]) => mountSfc(webFile('components', 'fleet', 'FleetLogNotices.vue'), {
    props: { notices, timelineHref: '/p/fleet/jobs/j1#timeline', truncatedAt: 268_435_456 }, globals, components: uiStubs,
  })

  test('renders each notice with its numbers', () => {
    const m = mount([{ key: 'bundle' }, { key: 'truncated' }, { key: 'incomplete', size: 1536 }])
    expect(m.textOf(m.find('[data-testid="fleet-log-notice-bundle"]')[0])).toContain('Filled from the bundle')
    expect(m.textOf(m.find('[data-testid="fleet-log-notice-truncated"]')[0])).toContain('256.0 MiB')
    expect(m.textOf(m.find('[data-testid="fleet-log-notice-incomplete"]')[0])).toContain('1.5 KiB received')
    m.unmount()
  })

  test('the legacy notice links to the timeline; expired says retention', () => {
    const legacy = mount([{ key: 'legacy' }])
    expect(legacy.find('[data-testid="fleet-log-notice-timeline"]')[0].props.to).toBe('/p/fleet/jobs/j1#timeline')
    legacy.unmount()
    const expired = mount([{ key: 'expired' }])
    expect(expired.text()).toContain('deleted after the retention window')
    expired.unmount()
  })

  test('nothing to say renders nothing', () => {
    const m = mount([])
    expect(m.find('[data-testid="fleet-log-notices"]')).toHaveLength(0)
    m.unmount()
  })
})
