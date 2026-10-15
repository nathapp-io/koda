import { describe, test, expect, jest, afterEach } from '@jest/globals'
import { nextTick } from 'vue'
import { mountSfc, webFile } from '../helpers/mount-sfc'
import type { FakeNode, Mounted } from '../helpers/mount-sfc'
import { uiStubs, i18nStub, toastRecorder } from '../helpers/fleet-harness'
import * as apiModule from '../../composables/useApi'

/**
 * US-006 AC10-AC13: the project brief field of components/SettingsProjectCard.vue.
 *
 * The card is mounted for real (no DOM: tests/helpers/mount-sfc.ts) with the shadcn primitives
 * stubbed, and the assertions are about what the admin sees (a textarea carrying the project's
 * brief, a 3000-character limit) and what the card sends (`$api.patch` payload).
 */

const cardFile = webFile('components', 'SettingsProjectCard.vue')

const patch = jest.fn(async () => ({}))

const project = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'p1',
  name: 'Web',
  slug: 'web',
  key: 'WEB',
  description: 'A project',
  brief: 'Old',
  ...over,
})

function mountCard(over: Record<string, unknown> = {}): Mounted {
  return mountSfc(cardFile, {
    props: { project: project(over) },
    components: uiStubs,
    alias: { '~/composables/useApi': apiModule },
    globals: {
      useApi: () => ({ $api: { patch } }),
      useI18n: () => i18nStub(),
      useAppToast: () => toastRecorder(),
    },
  })
}

/** The brief textarea, or the description one — the card has both. */
const field = (app: Mounted, testId: string): FakeNode | undefined => app.find(`[data-testid="${testId}"]`)[0]

/** Types into a stubbed textarea through its v-model handler, as a user keystroke would. */
async function type(app: Mounted, testId: string, value: string): Promise<void> {
  const node = field(app, testId)
  expect(node).toBeDefined()
  const update = node?.props['onUpdate:modelValue'] as ((next: string) => void) | undefined
  expect(typeof update).toBe('function')
  update?.(value)
  await nextTick()
}

/** Submits the card's form and waits for the request to settle. */
async function save(app: Mounted): Promise<void> {
  const form = app.one('form')
  expect(form).toBeDefined()
  await (form?.props.onSubmit as (event: { preventDefault: () => void }) => Promise<void>)({ preventDefault: jest.fn() })
  await nextTick()
}

afterEach(() => {
  patch.mockClear()
})

describe('US-006 AC10-AC13: the project brief field of SettingsProjectCard', () => {
  test('AC10: a project whose brief is Old shows a textarea holding Old with maxlength 3000', () => {
    const app = mountCard()

    const brief = field(app, 'project-brief')
    expect(brief).toBeDefined()
    expect(brief?.props.modelValue).toBe('Old')
    expect(brief?.props.maxlength).toBe(3000)

    app.unmount()
  })

  test('AC10 (label and count): the brief field is labelled and counts its characters', () => {
    const app = mountCard()

    expect(app.text()).toContain('projects.settings.brief')
    expect(field(app, 'project-brief')?.props.placeholder).toBe('projects.settings.briefHint')
    expect(app.text()).toContain('3/3000')

    app.unmount()
  })

  test('AC11: changing the brief to New and saving PATCHes /projects/web with brief New', async () => {
    const app = mountCard()

    await type(app, 'project-brief', 'New')
    expect(field(app, 'project-brief')?.props.modelValue).toBe('New')
    await save(app)

    expect(patch).toHaveBeenCalledTimes(1)
    expect(patch.mock.calls[0][0]).toBe('/projects/web')
    expect(patch.mock.calls[0][1]).toEqual({ brief: 'New' })

    app.unmount()
  })

  test('AC12: clearing the brief and saving PATCHes with brief null', async () => {
    const app = mountCard()

    await type(app, 'project-brief', '')
    await save(app)

    expect(patch).toHaveBeenCalledTimes(1)
    expect(patch.mock.calls[0][1]).toEqual({ brief: null })

    app.unmount()
  })

  test('AC13: saving with only the description changed sends no brief key', async () => {
    const app = mountCard()

    await type(app, 'project-description', 'A better description')
    await save(app)

    expect(patch).toHaveBeenCalledTimes(1)
    const payload = patch.mock.calls[0][1] as Record<string, unknown>
    expect(payload).toEqual({ description: 'A better description' })
    expect(Object.prototype.hasOwnProperty.call(payload, 'brief')).toBe(false)

    app.unmount()
  })

  test('saving with nothing changed sends no request', async () => {
    const app = mountCard()

    await save(app)

    expect(patch).not.toHaveBeenCalled()

    app.unmount()
  })

  test('a project without a brief shows an empty textarea and saving an untouched form sends no request', async () => {
    const app = mountCard({ brief: null })

    expect(field(app, 'project-brief')?.props.modelValue).toBe('')
    await save(app)

    expect(patch).not.toHaveBeenCalled()

    app.unmount()
  })

  test('a brief that is changed back to its stored value sends no brief key', async () => {
    const app = mountCard()

    await type(app, 'project-brief', 'New')
    await type(app, 'project-brief', 'Old')
    await save(app)

    expect(patch).not.toHaveBeenCalled()

    app.unmount()
  })
})
