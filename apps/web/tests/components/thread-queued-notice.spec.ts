import { describe, expect, test } from '@jest/globals'
import { mountSfc, webFile } from '../helpers/mount-sfc'
import { i18nStub } from '../helpers/fleet-harness'
import type { ThreadDetailDto } from '~/lib/thread-types'
import en from '../../i18n/locales/en.json'
import zh from '../../i18n/locales/zh.json'

const thread = (queuedTurn?: ThreadDetailDto['queuedTurn']): ThreadDetailDto => ({
  id: 't', kind: 'REPO', repoId: 'r', baseRef: 'main', feature: 'f', title: 'Thread', createdById: 'u',
  runnerId: null, backend: { kind: 'native' }, status: 'ACTIVE', archivedAt: null, skills: [], maxCostUsd: '5',
  costUsd: '0', tokens: null, specPath: null, pendingQuestion: null, session: null, lastActivityAt: '', createdAt: '',
  activeJob: null, writtenPaths: [], publishedSha: null, specPublished: false, lastWrite: null, preApproval: null,
  sendRefusal: null, handoff: { plan: null, run: null }, ...(queuedTurn === undefined ? {} : { queuedTurn }),
})
const reason = { runnerName: 'r1', reason: 'thread_backend' }
const queued = { jobId: 'j', queuedAt: '2026-01-01T00:00:00.000Z', verdict: 'no_fit', reasons: [reason] }
const mount = (value: ThreadDetailDto) => mountSfc(webFile('components', 'fleet', 'threads', 'ThreadQueuedNotice.vue'), {
  props: { thread: value }, globals: { useI18n: () => ({ ...i18nStub(), t: (key: string, params?: Record<string, string>) => key === 'fleet.threads.queued.reasonOn' ? `${params?.runner}: ${params?.reason}` : key }) },
})

describe('FleetThreadsThreadQueuedNotice', () => {
  test('AC-12, AC-13: both locales define non-empty queued verdict and misfit copy', () => {
    const threadReasons = ['thread_capacity', 'thread_backend', 'thread_modes', 'threads_disabled', 'thread_write', 'project_threads', 'workspace_threads']
    const verdicts = ['never', 'waiting_capacity', 'runners_paused', 'no_fit', 'no_runners', 'budget_paused']
    for (const locale of [en, zh]) {
      const fleet = locale.fleet as unknown as { misfit: Record<string, string>; threads: { queued: { title: string; reasonOn: string; verdict: Record<string, string> } } }
      for (const key of threadReasons) expect(fleet.misfit[key]?.trim()).not.toBe('')
      expect(fleet.threads.queued.title.trim()).not.toBe('')
      expect(fleet.threads.queued.reasonOn.trim()).not.toBe('')
      for (const verdict of verdicts) expect(fleet.threads.queued.verdict[verdict]?.trim()).not.toBe('')
    }
  })
  test('AC-1: renders nothing when queuedTurn is null', () => {
    const app = mount(thread(null))
    expect(app.one('[data-testid="thread-queued-notice"]')).toBeUndefined()
    app.unmount()
  })
  test('AC-2: renders nothing when queuedTurn is absent', () => {
    const app = mount(thread())
    expect(app.one('[data-testid="thread-queued-notice"]')).toBeUndefined()
    app.unmount()
  })
  test('AC-3..5: localizes title, verdict and one interpolation-safe reason per runner', () => {
    const app = mount(thread(queued))
    const notice = app.one('[data-testid="thread-queued-notice"]')
    expect(notice?.props.role).toBe('status')
    expect(app.text()).toContain('fleet.threads.queued.title')
    expect(app.text()).toContain('fleet.threads.queued.verdict.no_fit')
    const items = app.find('li')
    expect(items).toHaveLength(1)
    const firstItem = items[0]
    expect(firstItem).toBeDefined()
    expect(firstItem === undefined ? '' : app.textOf(firstItem)).toContain('r1')
    expect(firstItem === undefined ? '' : app.textOf(firstItem)).toContain('fleet.misfit.thread_backend')
    app.unmount()
  })
})

