import { describe, expect, test } from '@jest/globals'
import { mountSfc, webFile } from '../helpers/mount-sfc'
import type { Mounted } from '../helpers/mount-sfc'
import { i18nStub, uiStubs } from '../helpers/fleet-harness'
import type { FleetRunnerSummary } from '~/lib/fleet-types'
import type { ThreadDetailDto } from '~/lib/thread-types'

/**
 * US-006 AC-11 (fleet S5b 1d, 1d2-D12): ThreadHeader.vue — the scope label.
 *
 * A WORKSPACE thread has no repository and no feature branch: where a REPO thread shows
 * `feat/<feature>` and a PROJECT thread shows `fleet.threads.kind.project`, a WORKSPACE thread shows
 * its home project's name (`ThreadListTable` does the same for a WORKSPACE row). A WORKSPACE thread
 * that arrives without a `homeProject` (the API always sends one) falls back to
 * `fleet.threads.kind.workspace` rather than rendering `feat/null`.
 *
 * The REPO and PROJECT assertions of tests/components/thread-timeline.spec.ts are untouched; the
 * REPO case here is the control that pins "where a REPO thread shows feat/<feature>".
 */

const headerFile = webFile('components', 'fleet', 'threads', 'ThreadHeader.vue')

const threadDetail = (over: Record<string, unknown> = {}): ThreadDetailDto => ({
  id: 'th1',
  kind: 'REPO',
  repoId: 'r1',
  baseRef: 'main',
  feature: 'add-auth',
  title: 'Auth spec',
  createdById: 'u1',
  runnerId: null,
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
  lastActivityAt: '2026-10-14T00:00:00.000Z',
  createdAt: '2026-10-14T00:00:00.000Z',
  activeJob: null,
  sendRefusal: null,
  writtenPaths: [],
  publishedSha: null,
  specPublished: false,
  lastWrite: null,
  handoff: { plan: null, run: null },
  ...over,
})

const runner = (over: Record<string, unknown> = {}): FleetRunnerSummary => ({
  id: 'rn1',
  name: 'wk-mac',
  os: 'linux',
  arch: 'x64',
  labels: [],
  enabled: true,
  online: true,
  profiles: [],
  threadBackends: { native: ['m1'], acp: [] },
  projectThreads: true,
  workspaceThreads: true,
  ...over,
})

const mountHeader = (thread: ThreadDetailDto, runners: FleetRunnerSummary[] = []): Mounted =>
  mountSfc(headerFile, {
    props: { thread, runners },
    components: uiStubs,
    globals: { useI18n: () => i18nStub() },
  })

describe('US-006 AC-11: ThreadHeader scope label', () => {
  test('AC-11: a WORKSPACE thread whose home project name is Sandbox shows Sandbox and no feat/ text', () => {
    const app = mountHeader(threadDetail({
      kind: 'WORKSPACE',
      repoId: null,
      baseRef: null,
      feature: null,
      specPath: null,
      title: 'Plan the rollout',
      homeProject: { slug: 'acme', name: 'Sandbox' },
    }))

    expect(app.text()).toContain('Sandbox')
    expect(app.text()).not.toContain('feat/')
    app.unmount()
  })

  test('AC-11 (control): a REPO thread renders feat/add-auth in the same place', () => {
    const app = mountHeader(threadDetail())

    expect(app.text()).toContain('feat/add-auth')
    expect(app.text()).not.toContain('Sandbox')
    app.unmount()
  })

  test('AC-11 (edge): a WORKSPACE thread with no home project falls back to the fleet.threads.kind.workspace label, never feat/null', () => {
    const app = mountHeader(threadDetail({
      kind: 'WORKSPACE',
      repoId: null,
      baseRef: null,
      feature: null,
      specPath: null,
      title: 'Plan the rollout',
    }))

    expect(app.text()).toContain('fleet.threads.kind.workspace')
    expect(app.text()).not.toContain('feat/')
    app.unmount()
  })

  test('US-003 AC-6: an unmetered ACP thread shows the label and explanatory title instead of cost', () => {
    const app = mountHeader(threadDetail({
      backend: { kind: 'acp', agent: 'codex' }, costUsd: '0', maxCostUsd: '0.5',
      tokens: { input: 800, output: 76, cacheRead: 0, cacheWrite: 0 },
    }))
    const label = app.find('[title="fleet.threads.detail.unmeteredHint"]')[0]
    expect(app.text()).toContain('fleet.threads.detail.unmetered')
    expect(label).toBeDefined()
    expect(app.text()).not.toContain('$0 / $0.5')
    app.unmount()
  })

  test('US-003 AC-7: a metered native thread keeps its cost and cap text', () => {
    const app = mountHeader(threadDetail({ costUsd: '1.25', maxCostUsd: '5' }))
    expect(app.text()).toContain('$1.25 / $5')
    app.unmount()
  })

  test('AC-11 (edge): a WORKSPACE thread header still shows its runner and cost line', () => {
    const app = mountHeader(
      threadDetail({
        kind: 'WORKSPACE',
        repoId: null,
        baseRef: null,
        feature: null,
        specPath: null,
        title: 'Plan the rollout',
        runnerId: 'rn1',
        homeProject: { slug: 'acme', name: 'Sandbox' },
      }),
      [runner({ id: 'rn1', name: 'wk-mac', online: true })],
    )

    expect(app.text()).toContain('Sandbox')
    expect(app.text()).toContain('wk-mac')
    expect(app.text()).toContain('fleet.common.online')
    expect(app.text()).toContain('$0 / $5')
    app.unmount()
  })
})
