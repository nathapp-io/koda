import { describe, expect, test } from '@jest/globals'
import { ref, computed, watch } from 'vue'
import { mountSfc, webFile } from '../helpers/mount-sfc'
import type { FakeNode } from '../helpers/mount-sfc'
import { uiStubs, i18nStub } from '../helpers/fleet-harness'
import type { ThreadDto } from '~/lib/thread-types'

const threadListTableFile = webFile('components', 'ThreadListTable.vue')

const listItem = (overrides: Record<string, unknown> = {}): ThreadDto => ({
  id: 'th1',
  repoId: 'r1',
  baseRef: 'main',
  feature: 'f1',
  title: 'Auth spec',
  createdById: 'u1',
  runnerId: 'rn1',
  backend: { kind: 'native', model: 'gpt-5' },
  status: 'ACTIVE',
  archivedAt: null,
  skills: [],
  maxCostUsd: '5',
  costUsd: '0',
  tokens: null,
  specPath: '.nax/features/f1/prd.json',
  pendingQuestion: null,
  session: null,
  lastActivityAt: '2026-10-14T00:00:00.000Z',
  createdAt: '2026-10-14T00:00:00.000Z',
  activeJob: null,
  ...overrides,
})

/**
 * Mounts the real ThreadListTable with the props the component contract states
 * (threads, status, nameOf, slug). Labels use an i18n stub that returns the key,
 * so an assertion like "shows the fleet.threads.session.live label" pins the
 * exact key the component resolves for a session state.
 */
function mountTable(
  threads: ThreadDto[],
  over: { status?: 'ACTIVE' | 'ARCHIVED'; nameOf?: (userId: string) => string | null } = {},
) {
  return mountSfc(threadListTableFile, {
    props: {
      threads,
      status: over.status ?? 'ACTIVE',
      nameOf: over.nameOf ?? (() => 'Dana'),
      slug: 'web',
    },
    components: uiStubs,
    globals: {
      ref, computed, watch,
      useI18n: () => i18nStub(),
    },
  })
}

/** The first node (component stub or native element) whose `to` or `href` is the given path. */
function linkTo(app: { root: FakeNode }, to: string): FakeNode | undefined {
  const found: FakeNode[] = []
  const walk = (node: FakeNode): void => {
    if (node.props.to === to || node.props.href === to) found.push(node)
    node.children.forEach(walk)
  }
  walk(app.root)
  return found[0]
}

describe('US-004 AC5-AC10: ThreadListTable row rendering', () => {
  test('AC5: with threads [t] renders a link to /web/threads/th1 whose text is the title Auth spec', () => {
    const app = mountTable([listItem()])

    const link = linkTo(app, '/web/threads/th1')
    expect(link).toBeDefined()
    expect(app.textOf(link as FakeNode)).toBe('Auth spec')
  })

  test('AC5 (boundary): with no threads the table renders no row link', () => {
    const app = mountTable([])

    expect(linkTo(app, '/web/threads/th1')).toBeUndefined()
  })

  test('AC6: with a nameOf returning Dana for u1 the creator shows Dana, not the raw id', () => {
    const app = mountTable([listItem()], { nameOf: () => 'Dana' })

    const text = app.text()
    expect(text).toContain('Dana')
    expect(text).not.toContain('u1')
  })

  test('AC7: when nameOf returns null the raw createdById u1 is shown', () => {
    const app = mountTable([listItem()], { nameOf: () => null })

    expect(app.text()).toContain('u1')
  })

  test('AC8: with threads [t] the cost text is $0 / $5', () => {
    const app = mountTable([listItem()])

    expect(app.text()).toContain('$0 / $5')
  })

  test('AC9: a thread whose activeJob.state is RUNNING shows the fleet.threads.session.live label', () => {
    const app = mountTable([listItem({ activeJob: { id: 'j1', state: 'RUNNING' } })])

    expect(app.text()).toContain('fleet.threads.session.live')
  })

  test('AC10: with no threads and status ARCHIVED the empty state is fleet.threads.list.emptyArchived', () => {
    const app = mountTable([], { status: 'ARCHIVED' })

    expect(app.text()).toContain('fleet.threads.list.emptyArchived')
  })
})