import { describe, test, expect, afterEach, jest } from '@jest/globals'
import * as Vue from 'vue'
import { ref, computed, watch, nextTick } from 'vue'
import { mountSfc, webFile, loadSfc } from '../helpers/mount-sfc'
import { uiStubs, enI18n, toastRecorder } from '../helpers/fleet-harness'
import * as apiModule from '../../composables/useApi'
import { ApiError } from '../../composables/useApi'
import type { FakeNode } from '../helpers/mount-sfc'

const dialog = webFile('components', 'AddSkillSourceDialog.vue')

const source = (over: Record<string, unknown> = {}) => ({
  id: 'src1', gitUrl: 'https://github.com/o/r', ref: 'main', path: '', resolvedSha: null, resolvedAt: null,
  status: 'OK', statusReason: null, createdAt: '2026-10-01T00:00:00Z', skills: [], ...over,
})

afterEach(() => {
  delete (globalThis as Record<string, unknown>).useApi
})

/**
 * Mounts the real dialog with the real vee-validate FormField/FormMessage. The fleet harness stubs
 * FormField inertly, which would hide the validation message this story pins.
 */
function mountAddDialog(over: { create?: jest.Mock } = {}) {
  const create = over.create ?? jest.fn(async (input: unknown) => source(input as Record<string, unknown>))
  const toasts = toastRecorder()
  const catalog = { list: jest.fn(), create, update: jest.fn(), remove: jest.fn() }
  const api = { get: jest.fn(), post: jest.fn(), delete: jest.fn() }
  ;(globalThis as Record<string, unknown>).useApi = () => ({ $api: api })
  const app = mountSfc(dialog, {
    components: {
      ...uiStubs,
      FormField: loadSfc(webFile('components', 'ui', 'form', 'FormField.vue')),
      FormMessage: loadSfc(webFile('components', 'ui', 'form', 'FormMessage.vue')),
    },
    props: { open: true },
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
  const flush = async (): Promise<void> => {
    for (let i = 0; i < 6; i += 1) {
      await new Promise((resolve) => { setImmediate(resolve) })
      await new Promise((resolve) => { setTimeout(resolve, 0) })
      await Vue.nextTick()
    }
  }
  return { app, create, toasts, flush }
}

type Mounted = ReturnType<typeof mountAddDialog>['app']

/** Sets a field through the binding the form renders on each input (addressed by its test id). */
function typeInto(app: Mounted, testid: string, value: string): void {
  const field = app.find('[data-stub="input"]').find((n: FakeNode) => n.props['data-testid'] === testid)
  if (!field) throw new Error(`no input ${testid}`)
  ;(field.props['onUpdate:modelValue'] as (v: string) => void)(value)
}

const submit = async (app: Mounted): Promise<void> => {
  await (app.one('form')?.props.onSubmit as () => Promise<void>)()
}

describe('AddSkillSourceDialog (US-006)', () => {
  test('US-006 AC13: a non-GitHub URL shows the skills.form.gitUrlInvalid message and create is not called', async () => {
    const { app, create, flush } = mountAddDialog()
    await flush()
    typeInto(app, 'skill-source-git-url', 'https://gitlab.com/a/b')
    typeInto(app, 'skill-source-ref', 'main')
    await flush()

    await submit(app)
    await flush()

    expect(app.text()).toContain(enI18n().t('skills.form.gitUrlInvalid'))
    expect(create).not.toHaveBeenCalled()
    app.unmount()
  })

  test.each([
    ['a trailing slash', 'https://github.com/o/r/'],
    ['a trailing slash after .git', 'https://github.com/o/r.git/'],
    ['an uppercase host', 'https://GITHUB.com/o/r'],
    ['uppercase owner and repo', 'https://github.com/Owner/Repo'],
  ])('US-006 AC13 (URL parity): the form accepts %s, which the API also accepts', async (_label, gitUrl) => {
    const { app, create, flush } = mountAddDialog()
    await flush()
    typeInto(app, 'skill-source-git-url', gitUrl)
    typeInto(app, 'skill-source-ref', 'main')
    await flush()

    await submit(app)
    await flush()

    expect(create).toHaveBeenCalledWith({ gitUrl, ref: 'main', path: '' })
    app.unmount()
  })

  test.each([
    ['a dot segment', 'https://github.com/acme/..'],
    ['a dot owner', 'https://github.com/./repo'],
    ['a .git repo name', 'https://github.com/acme/.git'],
    ['a query string', 'https://github.com/o/r?x=1'],
    ['a character outside the API set', 'https://github.com/o/r!'],
    ['a repo name over 100 characters', `https://github.com/o/${'a'.repeat(101)}`],
  ])('US-006 AC13 (URL parity): the form refuses %s, which the API also refuses', async (_label, gitUrl) => {
    const { app, create, flush } = mountAddDialog()
    await flush()
    typeInto(app, 'skill-source-git-url', gitUrl)
    typeInto(app, 'skill-source-ref', 'main')
    await flush()

    await submit(app)
    await flush()

    expect(app.text()).toContain(enI18n().t('skills.form.gitUrlInvalid'))
    expect(create).not.toHaveBeenCalled()
    app.unmount()
  })

  test('US-006 AC14: a valid submit with an empty path calls create with path empty string', async () => {
    const { app, create, flush } = mountAddDialog()
    await flush()
    typeInto(app, 'skill-source-git-url', 'https://github.com/o/r')
    typeInto(app, 'skill-source-ref', 'main')
    await flush()

    await submit(app)
    await flush()

    expect(create).toHaveBeenCalledWith({ gitUrl: 'https://github.com/o/r', ref: 'main', path: '' })
    app.unmount()
  })

  test('US-006 AC12: a successful create emits created with the returned source and closes the dialog', async () => {
    const { app, create, flush } = mountAddDialog()
    await flush()
    typeInto(app, 'skill-source-git-url', 'https://github.com/o/r')
    typeInto(app, 'skill-source-ref', 'main')
    typeInto(app, 'skill-source-path', 'skills')
    await flush()

    await submit(app)
    await flush()

    expect(create).toHaveBeenCalledWith({ gitUrl: 'https://github.com/o/r', ref: 'main', path: 'skills' })
    expect(app.emitted('created')).toEqual([[source({ path: 'skills' })]])
    expect(app.emitted('update:open').at(-1)).toEqual([false])
    app.unmount()
  })

  test('US-006 AC15: a 409 from create shows a toast with the extracted API message and keeps the dialog open', async () => {
    const create = jest.fn(async () => { throw new ApiError(409, 'Skill source already registered') })
    const { app, toasts, flush } = mountAddDialog({ create })
    await flush()
    typeInto(app, 'skill-source-git-url', 'https://github.com/o/r')
    typeInto(app, 'skill-source-ref', 'main')
    await flush()

    await submit(app)
    await flush()

    expect(toasts.errors).toEqual(['Skill source already registered'])
    expect(app.emitted('created')).toHaveLength(0)
    expect(app.emitted('update:open')).toHaveLength(0)
    app.unmount()
  })
})
