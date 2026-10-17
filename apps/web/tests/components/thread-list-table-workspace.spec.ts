import { describe, expect, test } from '@jest/globals'
import { ref, computed, watch } from 'vue'
import { mountSfc, webFile } from '../helpers/mount-sfc'
import type { FakeNode, Mounted } from '../helpers/mount-sfc'
import { uiStubs, i18nStub } from '../helpers/fleet-harness'
import type { ThreadDto } from '~/lib/thread-types'

/**
 * US-005 AC-2/AC-3 (fleet S5b 1d): the personal `/threads` list reuses ThreadListTable, which owes
 * it two things a project table never needed — a row-link prefix that is not `/<slug>/threads`
 * (`basePath`), and the home project name where a REPO row shows `feat/<feature>`.
 */
const threadListTableFile = webFile('components', 'fleet', 'threads', 'ThreadListTable.vue')

/** A WORKSPACE thread: no repository, no feature, a home project instead (1d-1). */
const workspaceItem = (overrides: Record<string, unknown> = {}): ThreadDto => ({
  id: 'th1',
  kind: 'WORKSPACE',
  repoId: null,
  baseRef: null,
  feature: null,
  homeProject: { slug: 'web', name: 'Sandbox' },
  title: 'Plan the rollout',
  createdById: 'u1',
  runnerId: null,
  backend: { kind: 'native', model: 'gpt-5' },
  status: 'ACTIVE',
  archivedAt: null,
  skills: [],
  maxCostUsd: '5',
  costUsd: '0',
  tokens: null,
  specPath: null,
  pendingQuestion: null,
  session: null,
  lastActivityAt: '2026-10-14T00:00:00.000Z',
  createdAt: '2026-10-14T00:00:00.000Z',
  activeJob: null,
  writtenPaths: [],
  publishedSha: null,
  specPublished: false,
  lastWrite: null,
  ...overrides,
})

/** The personal list's props: no slug, a `basePath` of `/threads`. */
function mountPersonalTable(threads: ThreadDto[], over: { basePath?: string } = {}) {
  return mountSfc(threadListTableFile, {
    props: {
      threads,
      status: 'ACTIVE',
      nameOf: () => 'Dana',
      ...(over.basePath === undefined ? { basePath: '/threads' } : { basePath: over.basePath }),
    },
    components: uiStubs,
    globals: { ref, computed, watch, useI18n: () => i18nStub() },
  })
}

/** The first node whose `to` or `href` is the given path. */
function linkTo(app: { root: FakeNode }, to: string): FakeNode | undefined {
  const found: FakeNode[] = []
  const walk = (node: FakeNode): void => {
    if (node.props.to === to || node.props.href === to) found.push(node)
    node.children.forEach(walk)
  }
  walk(app.root)
  return found[0]
}

/** The table's first body row (the header row carries `th`, so it has no `td`). */
const bodyRow = (app: Mounted): FakeNode | undefined => app.find('tr').find(row => app.find('td', row).length > 0)

/** The feature column cell: the row's third cell (title, creator, feature). */
const featureCell = (app: Mounted): FakeNode | undefined => {
  const row = bodyRow(app)
  return row ? app.find('td', row)[2] : undefined
}

describe('US-005 AC-2/AC-3: ThreadListTable for the personal thread list', () => {
  test('AC-2: with basePath /threads and no slug a row links to /threads/th1', () => {
    const app = mountPersonalTable([workspaceItem()])

    const link = linkTo(app, '/threads/th1')
    expect(link).toBeDefined()
    expect(app.textOf(link as FakeNode)).toBe('Plan the rollout')
  })

  test('AC-3: a WORKSPACE row shows its home project name where a REPO row shows feat/<feature>', () => {
    const app = mountPersonalTable([workspaceItem({ homeProject: { slug: 'web', name: 'Sandbox' } })])

    const cell = featureCell(app)
    expect(cell).toBeDefined()
    expect(app.textOf(cell as FakeNode)).toBe('Sandbox')
    expect(app.text()).not.toContain('feat/')
  })

  test('AC-3 (edge): a WORKSPACE row without a home project falls back to the fleet.threads.kind.workspace label', () => {
    const app = mountPersonalTable([workspaceItem({ homeProject: undefined })])

    const cell = featureCell(app)
    expect(cell).toBeDefined()
    expect(app.textOf(cell as FakeNode)).toBe('fleet.threads.kind.workspace')
  })

  test('AC-2 (boundary): a project table with slug still links through /<slug>/threads', () => {
    const app = mountSfc(threadListTableFile, {
      props: { threads: [workspaceItem()], status: 'ACTIVE', nameOf: () => 'Dana', slug: 'web' },
      components: uiStubs,
      globals: { ref, computed, watch, useI18n: () => i18nStub() },
    })

    expect(linkTo(app, '/web/threads/th1')).toBeDefined()
    expect(linkTo(app, '/threads/th1')).toBeUndefined()
  })

  test('M3: with neither slug nor basePath a row links to /threads/th1, never //threads/th1', () => {
    const app = mountSfc(threadListTableFile, {
      props: { threads: [workspaceItem()], status: 'ACTIVE', nameOf: () => 'Dana' },
      components: uiStubs,
      globals: { ref, computed, watch, useI18n: () => i18nStub() },
    })

    expect(linkTo(app, '/threads/th1')).toBeDefined()
    const links: FakeNode[] = []
    const walk = (node: FakeNode): void => {
      if (typeof node.props.to === 'string') links.push(node)
      node.children.forEach(walk)
    }
    walk(app.root)
    expect(links.map(link => link.props.to)).not.toContain('//threads/th1')
  })
})
