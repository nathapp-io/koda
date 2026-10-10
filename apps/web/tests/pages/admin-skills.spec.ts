import { describe, test, expect, afterEach, jest } from '@jest/globals'
import * as Vue from 'vue'
import { ref, computed, watch, nextTick } from 'vue'
import { mountSfc, webFile } from '../helpers/mount-sfc'
import { uiStubs, enI18n, toastRecorder, ToastRecorder } from '../helpers/fleet-harness'
import * as apiModule from '../../composables/useApi'
import { ApiError } from '../../composables/useApi'
import type { FakeNode } from '../helpers/mount-sfc'

const page = webFile('pages', 'admin', 'skills.vue')

interface SkillDto { id: string; name: string; description: string; dir: string }
interface SourceDto {
  id: string; gitUrl: string; ref: string; path: string; resolvedSha: string | null; resolvedAt: string | null
  status: string; statusReason: string | null; createdAt: string; skills: SkillDto[]
}

const source = (id: string, over: Partial<SourceDto> = {}): SourceDto => ({
  id, gitUrl: `https://github.com/o/${id}`, ref: 'main', path: 'skills', resolvedSha: '0123456789abcdef',
  resolvedAt: '2026-10-01T00:00:00Z', status: 'OK', statusReason: null, createdAt: '2026-10-01T00:00:00Z', skills: [], ...over,
})

interface Catalog {
  list: jest.Mock
  create: jest.Mock
  update: jest.Mock
  remove: jest.Mock
}

/**
 * Stands in for AddSkillSourceDialog so the page test controls what it opens with and what it
 * emits; the dialog's own behaviour is covered by tests/components/add-skill-source-dialog.spec.ts.
 */
const addDialogStub = {
  name: 'StubAddSkillSourceDialog',
  props: ['open'],
  setup(props: { open?: boolean }, { attrs }: { attrs: Record<string, unknown> }) {
    return () => Vue.h('x-stub-stub', { ...attrs, 'data-stub': 'add-skill-source-dialog', open: props.open === true })
  },
}

interface Mounted {
  app: ReturnType<typeof mountSfc>
  catalog: Catalog
  toasts: ToastRecorder
  settle: () => Promise<void>
  rows: () => FakeNode[]
  rowOf: (id: string) => FakeNode
  buttonIn: (label: string, scope?: FakeNode) => FakeNode
  click: (node: FakeNode) => void | Promise<void>
  unmount: () => void
}

function mountSkills(over: { sources?: SourceDto[]; list?: jest.Mock; update?: jest.Mock; confirm?: boolean } = {}): Mounted {
  const catalog: Catalog = {
    list: over.list ?? jest.fn(async () => over.sources ?? [source('alpha')]),
    create: jest.fn(async () => source('new')),
    update: over.update ?? jest.fn(async (id: string) => source(id)),
    remove: jest.fn(async () => undefined),
  }
  const toasts = toastRecorder()
  globalThis.window = { confirm: () => over.confirm ?? true } as never

  const app = mountSfc(page, {
    components: { ...uiStubs, AddSkillSourceDialog: addDialogStub },
    alias: { '~/composables/useApi': apiModule },
    globals: {
      ref, computed, watch, nextTick,
      onMounted: Vue.onMounted,
      onBeforeUnmount: Vue.onBeforeUnmount,
      useI18n: () => enI18n(),
      useAppToast: () => toasts,
      useSkillCatalog: () => catalog,
    },
  })

  const settle = async (): Promise<void> => {
    for (let i = 0; i < 5; i += 1) {
      await new Promise((resolve) => { setImmediate(resolve) })
      await Vue.nextTick()
    }
  }
  const rows = (): FakeNode[] => app.find('[data-stub="tbody"] > [data-stub="tr"]')
  const rowOf = (id: string): FakeNode => {
    const row = rows().find((r) => r.props['data-testid'] === `skill-source-${id}`)
    if (!row) throw new Error(`no row for ${id} in: ${app.text()}`)
    return row
  }
  const buttonIn = (label: string, scope?: FakeNode): FakeNode => {
    const match = app.find('[data-stub="button"]', scope).filter((b) => app.textOf(b) === label)
    if (match.length !== 1) throw new Error(`expected one "${label}" button, found ${match.length} in: ${app.text()}`)
    return match[0]
  }
  const click = (node: FakeNode) => (node.props.onClick as () => void | Promise<void>)()
  return { app, catalog, toasts, settle, rows, rowOf, buttonIn, click, unmount: app.unmount }
}

/** The nth cell (0-based) of a row: URL, ref, SHA, path, status, skills, actions. */
function cellOf(app: Mounted['app'], row: FakeNode, index: number): string {
  return app.textOf(app.find('[data-stub="td"]', row)[index])
}

afterEach(() => {
  delete (globalThis as Record<string, unknown>).window
})

describe('Admin skills page (US-006)', () => {
  test('US-006 AC5: a source with a resolved sha renders its first seven characters', async () => {
    const { app, rowOf, settle, unmount } = mountSkills({ sources: [source('alpha', { resolvedSha: '0123456789abcdef' })] })
    await settle()

    expect(cellOf(app, rowOf('alpha'), 2)).toBe('0123456')
    unmount()
  })

  test('US-006 AC6: a source with no resolved sha renders an em dash in the sha column', async () => {
    const { app, rowOf, settle, unmount } = mountSkills({ sources: [source('alpha', { resolvedSha: null })] })
    await settle()

    expect(cellOf(app, rowOf('alpha'), 2)).toBe('—')
    unmount()
  })

  test('US-006 AC7: a RESOLVE_FAILED source shows a failure badge that includes its statusReason', async () => {
    const { app, rowOf, settle, unmount } = mountSkills({
      sources: [source('alpha', { status: 'RESOLVE_FAILED', statusReason: 'rate_limited' })],
    })
    await settle()

    const badges = app.find('[data-stub="badge"]', rowOf('alpha')).map((b) => app.textOf(b))
    expect(badges.some((text) => text.includes('rate_limited'))).toBe(true)
    unmount()
  })

  test('US-006 AC8: expanding a source row lists each skill name and description', async () => {
    const skills: SkillDto[] = [
      { id: 's1', name: 'spec-review', description: 'Review a spec', dir: 'skills/spec-review' },
      { id: 's2', name: 'plan-cut', description: 'Cut a plan', dir: 'skills/plan-cut' },
    ]
    const { app, rowOf, buttonIn, click, settle, unmount } = mountSkills({ sources: [source('alpha', { skills })] })
    await settle()

    await click(buttonIn(enI18n().t('skills.actions.showSkills'), rowOf('alpha')))
    await settle()

    const text = app.text()
    expect(text).toContain('spec-review')
    expect(text).toContain('Review a spec')
    expect(text).toContain('plan-cut')
    expect(text).toContain('Cut a plan')
    unmount()
  })

  test('US-006 AC9: Update calls update with the row id and re-renders the row from the returned source', async () => {
    const update = jest.fn(async (id: string) => source(id, { resolvedSha: 'fedcba9876543210' }))
    const { app, catalog, rowOf, buttonIn, click, settle, unmount } = mountSkills({ update })
    await settle()

    await click(buttonIn(enI18n().t('skills.actions.update'), rowOf('alpha')))
    await settle()

    expect(catalog.update).toHaveBeenCalledWith('alpha')
    expect(cellOf(app, rowOf('alpha'), 2)).toBe('fedcba9')
    unmount()
  })

  test('US-006 AC10: Remove calls remove after the confirmation is accepted', async () => {
    const { catalog, rowOf, buttonIn, click, settle, unmount } = mountSkills()
    await settle()

    await click(buttonIn(enI18n().t('skills.actions.remove'), rowOf('alpha')))
    await settle()

    expect(catalog.remove).toHaveBeenCalledWith('alpha')
    unmount()
  })

  test('US-006 AC10 (boundary): a cancelled Remove confirmation calls nothing', async () => {
    const { catalog, rowOf, buttonIn, click, settle, unmount } = mountSkills({ confirm: false })
    await settle()

    await click(buttonIn(enI18n().t('skills.actions.remove'), rowOf('alpha')))
    await settle()

    expect(catalog.remove).not.toHaveBeenCalled()
    unmount()
  })

  test('US-006 AC11: a list 403 renders the skills.adminOnly note and no Add button', async () => {
    const list = jest.fn(async () => { throw new ApiError(40003, 'forbidden') })
    const { app, settle, unmount } = mountSkills({ list })
    await settle()

    expect(app.text()).toContain(enI18n().t('skills.adminOnly'))
    expect(app.find('[data-stub="button"]').map((b) => app.textOf(b))).not.toContain(enI18n().t('skills.actions.add'))
    unmount()
  })

  test('US-006 (error path): a non-403 list failure toasts the API message and shows no admin note', async () => {
    const list = jest.fn(async () => { throw new ApiError(500, 'Catalog unavailable') })
    const { app, toasts, settle, unmount } = mountSkills({ list })
    await settle()

    expect(toasts.errors).toEqual(['Catalog unavailable'])
    expect(app.text()).not.toContain(enI18n().t('skills.adminOnly'))
    unmount()
  })

  test('US-006 (error path): a failed Update toasts the message and leaves the row unchanged', async () => {
    const update = jest.fn(async () => { throw new ApiError(500, 'Resolve failed') })
    const { app, toasts, rowOf, buttonIn, click, settle, unmount } = mountSkills({ update })
    await settle()

    await click(buttonIn(enI18n().t('skills.actions.update'), rowOf('alpha')))
    await settle()

    expect(toasts.errors).toEqual(['Resolve failed'])
    expect(cellOf(app, rowOf('alpha'), 2)).toBe('0123456')
    unmount()
  })

  test('US-006 (error path): a failed Remove toasts the message and keeps the row', async () => {
    const { app, catalog, toasts, rowOf, buttonIn, click, settle, unmount } = mountSkills()
    catalog.remove.mockImplementationOnce(async () => { throw new ApiError(500, 'Remove failed') })
    await settle()

    await click(buttonIn(enI18n().t('skills.actions.remove'), rowOf('alpha')))
    await settle()

    expect(toasts.errors).toEqual(['Remove failed'])
    expect(app.find('[data-stub="tbody"] > [data-stub="tr"]')).toHaveLength(1)
    unmount()
  })

  test('US-006 AC11 (control): a successful list shows the Add button, so the 403 case above is not vacuous', async () => {
    const { app, settle, unmount } = mountSkills()
    await settle()

    expect(app.find('[data-stub="button"]').map((b) => app.textOf(b))).toContain(enI18n().t('skills.actions.add'))
    unmount()
  })

  test('US-006 AC12: Add opens the dialog and a created source renders as a new row', async () => {
    const { app, rowOf, buttonIn, click, settle, unmount } = mountSkills()
    await settle()

    await click(buttonIn(enI18n().t('skills.actions.add')))
    await settle()
    const dialogNode = app.find('[data-stub="add-skill-source-dialog"]')[0]
    expect(dialogNode.props.open).toBe(true)

    ;(dialogNode.props.onCreated as (s: SourceDto) => void)(source('new'))
    await settle()

    expect(rowOf('new')).toBeDefined()
    unmount()
  })
})
