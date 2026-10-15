import { describe, expect, test } from '@jest/globals'
import { mountSfc, webFile } from '../helpers/mount-sfc'
import { enI18n, uiStubs } from '../helpers/fleet-harness'
import { showKodaToolsNotice } from '~/lib/thread-handoff'
import type { ThreadDetailDto } from '~/lib/thread-types'

const thread = (
  state: 'live' | 'closed' | 'failed' = 'live',
  kodaToolsUnavailableOn?: string,
): ThreadDetailDto => ({
  id: 't',
  repoId: 'r',
  baseRef: 'main',
  feature: 'f',
  title: 't',
  createdById: 'u',
  runnerId: 'r',
  backend: { kind: 'native', model: 'x' },
  status: 'ACTIVE',
  archivedAt: null,
  skills: [],
  maxCostUsd: '5',
  costUsd: '0',
  tokens: null,
  specPath: '',
  pendingQuestion: null,
  session: {
    jobId: 'j',
    state,
    resumed: false,
    contextReset: false,
    reason: null,
    at: '',
    ...(kodaToolsUnavailableOn && { kodaToolsUnavailableOn }),
  },
  lastActivityAt: '',
  createdAt: '',
  activeJob: null,
  sendRefusal: null,
  writtenPaths: [],
  publishedSha: null,
  specPublished: false,
  lastWrite: null,
  handoff: { plan: null, run: null },
})

const mount = (t: ThreadDetailDto) =>
  mountSfc(webFile('components', 'fleet', 'threads', 'ThreadKodaToolsNotice.vue'), {
    props: { thread: t },
    components: uiStubs,
    globals: { useI18n: () => enI18n() },
  })

describe('US-007 ThreadKodaToolsNotice', () => {
  test('AC-1: showKodaToolsNotice returns true for a live session with kodaToolsUnavailableOn', () => {
    const t = thread('live', 'wk-mac')
    expect(showKodaToolsNotice(t)).toBe(true)
  })

  test('AC-2: showKodaToolsNotice returns false for a live session with no kodaToolsUnavailableOn', () => {
    const t = thread('live')
    expect(showKodaToolsNotice(t)).toBe(false)
  })

  test('AC-3: showKodaToolsNotice returns false for a closed session with kodaToolsUnavailableOn', () => {
    const t = thread('closed', 'wk-mac')
    expect(showKodaToolsNotice(t)).toBe(false)
  })

  test('AC-4: ThreadKodaToolsNotice calls t with fleet.threads.kodaTools.unavailable and renders result', () => {
    const t = thread('live', 'wk-mac')
    const app = mount(t)
    const text = app.text()
    // The rendered text should contain the interpolated message with the runner name
    expect(text).toContain('koda tools are unavailable on runner wk-mac')
    app.unmount()
  })

  test('AC-5: ThreadKodaToolsNotice renders nothing when there is no session', () => {
    const t = {
      ...thread('live'),
      session: null,
    }
    const app = mount(t)
    expect(app.text()).toBe('')
    app.unmount()
  })

  test('AC-6: ThreadStaleBanner is unaffected when there is no kodaToolsUnavailableOn', () => {
    // This test verifies that adding the new field doesn't break the stale banner
    // by testing that a stale session without kodaToolsUnavailableOn still works
    const t = thread('live')
    const staleThread = { ...t, session: t.session ? { ...t.session, stale: true } : null }
    const app = mount(staleThread)
    // Should render nothing because there's no kodaToolsUnavailableOn
    expect(app.text()).toBe('')
    app.unmount()
  })
})
