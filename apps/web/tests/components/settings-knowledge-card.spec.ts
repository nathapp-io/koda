import { describe, test, expect, jest, afterEach } from '@jest/globals'
import { nextTick } from 'vue'
import { mountSfc, webFile } from '../helpers/mount-sfc'
import type { FakeNode, Mounted } from '../helpers/mount-sfc'
import { uiStubs, i18nStub, toastRecorder } from '../helpers/fleet-harness'
import type { ToastRecorder } from '../helpers/fleet-harness'
import * as apiModule from '../../composables/useApi'

/**
 * US-007 AC1-AC10: components/SettingsKnowledgeCard.vue, mounted for real (no DOM:
 * tests/helpers/mount-sfc.ts) with the shadcn primitives stubbed. Assertions are about what the
 * member sees (rows, notices, read-only editor) and what the card sends (`$api` calls).
 */

const cardFile = webFile('components', 'SettingsKnowledgeCard.vue')

const repo = {
  repoId: 'r1',
  owner: 'o',
  name: 'n',
  provider: 'github',
  status: 'idle',
  indexedSha: 'abcdef1234',
  fileCount: 3,
  chunkCount: 9,
  unembeddedCount: 0,
  skippedCount: 1,
  lastError: null,
  startedAt: null,
  finishedAt: '2026-10-16T10:00:00.000Z',
}

const answer = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  enabled: true,
  patterns: ['docs/**/*.md'],
  customPatterns: false,
  defaultPatterns: ['docs/**/*.md'],
  repos: [repo],
  ...over,
})

const get = jest.fn(async (_path: string): Promise<unknown> => answer())
const post = jest.fn(async (_path: string, _body?: unknown): Promise<unknown> => ({ queued: true }))
const put = jest.fn(async (_path: string, _body?: unknown): Promise<unknown> => ({}))

let toast: ToastRecorder

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await nextTick()
  await new Promise((resolve) => setTimeout(resolve, 0))
  await nextTick()
}

async function mountCard(role: string | undefined = 'ADMIN'): Promise<Mounted> {
  toast = toastRecorder()
  const app = mountSfc(cardFile, {
    props: { slug: 'web' },
    components: uiStubs,
    alias: { '~/composables/useApi': apiModule },
    globals: {
      useApi: () => ({ $api: { get, post, put } }),
      useI18n: () => i18nStub(),
      useAppToast: () => toast,
      useAuth: () => ({ user: { value: role === undefined ? null : { role } } }),
    },
  })
  await flush()
  return app
}

const byId = (app: Mounted, testId: string): FakeNode | undefined => app.find(`[data-testid="${testId}"]`)[0]

async function type(app: Mounted, value: string): Promise<void> {
  const update = byId(app, 'knowledge-patterns')?.props['onUpdate:modelValue'] as ((next: string) => void) | undefined
  expect(typeof update).toBe('function')
  update?.(value)
  await nextTick()
}

async function click(node: FakeNode | undefined): Promise<void> {
  expect(node).toBeDefined()
  await (node?.props.onClick as () => Promise<void> | void)()
  await flush()
}

async function save(app: Mounted): Promise<void> {
  const form = app.one('form')
  expect(form).toBeDefined()
  await (form?.props.onSubmit as (event: { preventDefault: () => void }) => Promise<void>)({ preventDefault: jest.fn() })
  await flush()
}

afterEach(() => {
  get.mockReset().mockImplementation(async () => answer())
  post.mockReset().mockImplementation(async () => ({ queued: true }))
  put.mockReset().mockImplementation(async () => ({}))
})

describe('US-007: the knowledge state', () => {
  test('AC1: loads /projects/web/knowledge/repos and renders the repository row with its state', async () => {
    const app = await mountCard()

    expect(get).toHaveBeenCalledWith('/projects/web/knowledge/repos')
    const row = byId(app, 'knowledge-repo-r1')
    expect(row).toBeDefined()
    const text = app.textOf(row as FakeNode)
    expect(text).toContain('o/n')
    expect(text).toContain('idle')
    expect(text).toContain('abcdef1')
    expect(text).not.toContain('abcdef12')
    app.unmount()
  })

  test('AC1 (counts): the row shows file, chunk, unembedded and skipped counts and a last error', async () => {
    get.mockImplementation(async () => answer({ repos: [{ ...repo, lastError: 'clone failed' }] }))
    const app = await mountCard()

    const text = app.textOf(byId(app, 'knowledge-repo-r1') as FakeNode)
    expect(text).toContain('3')
    expect(text).toContain('9')
    expect(text).toContain('clone failed')
    app.unmount()
  })

  test('AC2: with indexing disabled the card shows knowledge-disabled and no re-index button', async () => {
    get.mockImplementation(async () => answer({ enabled: false }))
    const app = await mountCard()

    expect(byId(app, 'knowledge-disabled')).toBeDefined()
    expect(byId(app, 'knowledge-reindex-r1')).toBeUndefined()
    app.unmount()
  })

  test('with indexing enabled there is no disabled notice', async () => {
    const app = await mountCard()

    expect(byId(app, 'knowledge-disabled')).toBeUndefined()
    app.unmount()
  })

  test('AC10: a failed first load renders the error state and its retry loads again', async () => {
    get.mockRejectedValueOnce(new Error('boom'))
    const app = await mountCard()

    const error = app.find('[data-stub="error-state"]')[0]
    expect(error).toBeDefined()
    expect(byId(app, 'knowledge-repo-r1')).toBeUndefined()
    expect(get).toHaveBeenCalledTimes(1)

    await click({ ...(error as FakeNode), props: { onClick: error?.props.onRetry } } as FakeNode)
    expect(get).toHaveBeenCalledTimes(2)
    expect(byId(app, 'knowledge-repo-r1')).toBeDefined()
    app.unmount()
  })
})

describe('US-007: re-index', () => {
  test('AC3: an admin clicking re-index posts the repository reindex path, then reloads the state', async () => {
    const app = await mountCard('ADMIN')
    expect(get).toHaveBeenCalledTimes(1)

    await click(byId(app, 'knowledge-reindex-r1'))

    expect(post).toHaveBeenCalledWith('/projects/web/knowledge/repos/r1/reindex')
    expect(get).toHaveBeenCalledTimes(2)
    expect(toast.successes).toEqual(['knowledge.reindex.queued'])
    app.unmount()
  })

  test('AC9: a failed re-index toasts the API error and does not reload the state', async () => {
    post.mockRejectedValueOnce(new apiModule.ApiError(403, 'Not allowed'))
    const app = await mountCard('ADMIN')

    await click(byId(app, 'knowledge-reindex-r1'))

    expect(toast.errors).toEqual([apiModule.extractApiError(new apiModule.ApiError(403, 'Not allowed'))])
    expect(toast.errors[0]).toContain('Not allowed')
    expect(get).toHaveBeenCalledTimes(1)
    app.unmount()
  })
})

describe('US-007: the patterns editor', () => {
  test('AC4: a USER sees no re-index button and a read-only patterns textarea without save or reset', async () => {
    const app = await mountCard('USER')

    expect(byId(app, 'knowledge-reindex-r1')).toBeUndefined()
    const textarea = byId(app, 'knowledge-patterns')
    expect(textarea).toBeDefined()
    expect(textarea?.props.readonly).toBe(true)
    expect(textarea?.props.modelValue).toBe('docs/**/*.md')
    expect(byId(app, 'knowledge-patterns-save')).toBeUndefined()
    expect(byId(app, 'knowledge-patterns-reset')).toBeUndefined()
    app.unmount()
  })

  test('an admin gets an editable textarea holding one pattern per line', async () => {
    get.mockImplementation(async () => answer({ patterns: ['a/*.md', 'b/**/*.md'] }))
    const app = await mountCard('ADMIN')

    const textarea = byId(app, 'knowledge-patterns')
    expect(textarea?.props.readonly).toBe(false)
    expect(textarea?.props.modelValue).toBe('a/*.md\nb/**/*.md')
    app.unmount()
  })

  test('AC5: saving trimmed non-empty lines PUTs them as the patterns, then reloads', async () => {
    const app = await mountCard('ADMIN')

    await type(app, 'handbook/*.md\n\n docs/*.md ')
    await save(app)

    expect(put).toHaveBeenCalledTimes(1)
    expect(put).toHaveBeenCalledWith('/projects/web/knowledge/patterns', { patterns: ['handbook/*.md', 'docs/*.md'] })
    expect(toast.successes).toEqual(['knowledge.patterns.saved'])
    expect(get).toHaveBeenCalledTimes(2)
    app.unmount()
  })

  test('AC6: Reset to default PUTs null patterns, then reloads', async () => {
    const app = await mountCard('ADMIN')

    await click(byId(app, 'knowledge-patterns-reset'))

    expect(put).toHaveBeenCalledWith('/projects/web/knowledge/patterns', { patterns: null })
    expect(toast.successes).toEqual(['knowledge.patterns.reset'])
    expect(get).toHaveBeenCalledTimes(2)
    app.unmount()
  })

  test('AC7: a line that does not end in .md shows the validation message and sends nothing', async () => {
    const app = await mountCard('ADMIN')

    await type(app, 'src/a.ts')
    await save(app)

    expect(put).not.toHaveBeenCalled()
    expect(app.text()).toContain('knowledge.patterns.errorMarkdown')
    app.unmount()
  })

  test('an empty editor and more than 50 lines are rejected without a request', async () => {
    const app = await mountCard('ADMIN')

    await type(app, '  \n ')
    await save(app)
    expect(app.text()).toContain('knowledge.patterns.errorCount')

    await type(app, Array.from({ length: 51 }, (_, i) => `d${i}/*.md`).join('\n'))
    await save(app)
    expect(app.text()).toContain('knowledge.patterns.errorCount')
    expect(put).not.toHaveBeenCalled()
    app.unmount()
  })

  test('a valid save clears an earlier validation message', async () => {
    const app = await mountCard('ADMIN')

    await type(app, 'src/a.ts')
    await save(app)
    await type(app, 'docs/*.md')
    await save(app)

    expect(app.text()).not.toContain('knowledge.patterns.errorMarkdown')
    expect(put).toHaveBeenCalledTimes(1)
    app.unmount()
  })

  test('AC8: a rejected save toasts the API error and does not reload', async () => {
    put.mockRejectedValueOnce(new apiModule.ApiError(400, 'Invalid patterns'))
    const app = await mountCard('ADMIN')

    await type(app, 'docs/*.md')
    await save(app)

    expect(toast.errors).toHaveLength(1)
    expect(toast.errors[0]).toContain('Invalid patterns')
    expect(toast.successes).toEqual([])
    expect(get).toHaveBeenCalledTimes(1)
    app.unmount()
  })

  test('a rejected reset toasts the API error', async () => {
    put.mockRejectedValueOnce(new apiModule.ApiError(403, 'Nope'))
    const app = await mountCard('ADMIN')

    await click(byId(app, 'knowledge-patterns-reset'))

    expect(toast.errors).toHaveLength(1)
    expect(toast.errors[0]).toContain('Nope')
    app.unmount()
  })
})
