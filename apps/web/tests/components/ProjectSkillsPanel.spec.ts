import { describe, test, expect, jest, afterEach } from '@jest/globals'
import * as Vue from 'vue'
import { ref, computed, watch, nextTick } from 'vue'
import { mountSfc, webFile } from '../helpers/mount-sfc'
import { uiStubs, enI18n, toastRecorder, ToastRecorder } from '../helpers/fleet-harness'
import type { FakeNode } from '../helpers/mount-sfc'
import * as apiModule from '../../composables/useApi'
import { ApiError } from '../../composables/useApi'
import { useProjectSkills } from '../../composables/useProjectSkills'

const panelFile = webFile('components', 'ProjectSkillsPanel.vue')

interface ProjectSkill {
  id: string
  name: string
  description: string
  enabled: boolean
  source: { id: string; gitUrl: string; ref: string; resolvedSha: string | null; status: string }
}

const skill = (id: string, over: Partial<ProjectSkill> = {}): ProjectSkill => ({
  id,
  name: `${id}-name`,
  description: `${id} description`,
  enabled: false,
  source: { id: `src-${id}`, gitUrl: 'https://github.com/o/r', ref: 'main', resolvedSha: '0123456789abcdef', status: 'OK' },
  ...over,
})

/**
 * Stands in for the shadcn Switch so the panel's own logic is tested alone. The real wrapper's
 * forwarding (checked, disabled, update:checked) is exercised by tests/components/ui-switch.spec.ts.
 */
const switchStub = {
  name: 'StubSwitch',
  inheritAttrs: false,
  setup(_props: unknown, { attrs }: { attrs: Record<string, unknown> }) {
    return () => Vue.h('x-stub-stub', { ...attrs, 'data-stub': 'switch' })
  },
}

interface MountOver {
  items?: ProjectSkill[]
  canManage?: boolean
  /** When set, the viewer-role fetch fails with this error instead of resolving. */
  viewerError?: unknown
  list?: jest.Mock
  put?: jest.Mock
  del?: jest.Mock
}

function mountPanel(over: MountOver = {}) {
  const api = {
    get: over.list ?? jest.fn(async () => ({ items: over.items ?? [skill('alpha'), skill('beta', { enabled: true })] })),
    put: over.put ?? jest.fn(async () => ({})),
    delete: over.del ?? jest.fn(async () => ({})),
  }
  const toasts: ToastRecorder = toastRecorder()
  const canManage = over.canManage ?? true
  // The real useProjectSkills reads useApi() as a Nuxt global; point it at the fake api for this mount.
  ;(globalThis as Record<string, unknown>).useApi = () => ({ $api: api })

  const app = mountSfc(panelFile, {
    props: { slug: 'web' },
    components: { ...uiStubs, Switch: switchStub },
    alias: { '~/composables/useApi': apiModule },
    globals: {
      ref, computed, watch, nextTick,
      onMounted: Vue.onMounted,
      onBeforeUnmount: Vue.onBeforeUnmount,
      useI18n: () => enI18n(),
      useAppToast: () => toasts,
      useProjectSkills,
      useProjectViewerRole: () => ({
        data: ref({ canManage, viewerRole: canManage ? 'ADMIN' : 'DEVELOPER' }),
        error: ref(over.viewerError ?? null),
      }),
    },
  })

  const settle = async (): Promise<void> => {
    for (let i = 0; i < 5; i += 1) {
      await new Promise((resolve) => { setImmediate(resolve) })
      await Vue.nextTick()
    }
  }
  const rows = (): FakeNode[] => app.find('li')
  const switchIn = (id: string): FakeNode => {
    const match = app.find(`[data-testid="skill-switch-${id}"]`)
    if (match.length !== 1) throw new Error(`expected one switch for ${id}, found ${match.length} in: ${app.text()}`)
    return match[0]
  }
  /** Fires the switch's update:checked, as the radix wrapper does when the user flips it. */
  const toggle = (id: string, next: boolean): void => {
    const onUpdate = switchIn(id).props['onUpdate:checked'] as (value: boolean) => void
    onUpdate(next)
  }
  return { app, api, toasts, settle, rows, switchIn, toggle, unmount: () => app.unmount() }
}

afterEach(() => {
  delete (globalThis as Record<string, unknown>).useApi
})

describe('ProjectSkillsPanel (US-007)', () => {
  test('US-007 AC2: two items render two rows, each with name, description and the first 7 characters of resolvedSha', async () => {
    const { app, rows, settle, unmount } = mountPanel({
      items: [
        skill('alpha'),
        skill('beta', { source: { id: 's', gitUrl: 'u', ref: 'main', resolvedSha: 'fedcba9876543210', status: 'OK' } }),
      ],
    })
    await settle()

    expect(rows()).toHaveLength(2)
    const alphaRow = app.find('[data-testid="skill-row-alpha"]')[0]
    const betaRow = app.find('[data-testid="skill-row-beta"]')[0]
    expect(app.textOf(alphaRow)).toContain('alpha-name')
    expect(app.textOf(alphaRow)).toContain('alpha description')
    expect(app.textOf(alphaRow)).toContain('0123456')
    expect(app.textOf(alphaRow)).not.toContain('0123456789abcdef')
    expect(app.textOf(betaRow)).toContain('beta-name')
    expect(app.textOf(betaRow)).toContain('beta description')
    expect(app.textOf(betaRow)).toContain('fedcba9')
    unmount()
  })

  test('US-007 AC3: a row whose resolvedSha is null renders an em dash in place of the SHA', async () => {
    const { app, settle, unmount } = mountPanel({
      items: [skill('alpha', { source: { id: 's', gitUrl: 'u', ref: 'main', resolvedSha: null, status: 'OK' } })],
    })
    await settle()

    expect(app.textOf(app.find('[data-testid="skill-sha-alpha"]')[0])).toBe('—')
    unmount()
  })

  test('US-007 AC4: switching on a disabled skill calls enable, which sends PUT to the project skill route', async () => {
    const { api, toggle, settle, unmount } = mountPanel()
    await settle()

    toggle('alpha', true)
    await settle()

    expect(api.put).toHaveBeenCalledWith('/projects/web/skills/alpha')
    expect(api.delete).not.toHaveBeenCalled()
    unmount()
  })

  test('US-007 AC5: switching off an enabled skill calls disable, which sends DELETE to the project skill route', async () => {
    const { api, toggle, settle, unmount } = mountPanel()
    await settle()

    toggle('beta', false)
    await settle()

    expect(api.delete).toHaveBeenCalledWith('/projects/web/skills/beta')
    expect(api.put).not.toHaveBeenCalled()
    unmount()
  })

  test('US-007 AC4 (success): a successful enable leaves the switch on', async () => {
    const { switchIn, toggle, toasts, settle, unmount } = mountPanel()
    await settle()

    toggle('alpha', true)
    await settle()

    expect(switchIn('alpha').props.checked).toBe(true)
    expect(toasts.errors).toEqual([])
    unmount()
  })

  test('US-007 AC6: when enable rejects, the panel toasts the extracted API message and the switch shows off again', async () => {
    const put = jest.fn(async () => { throw new ApiError(403, 'Not allowed to manage skills') })
    const { switchIn, toggle, toasts, settle, unmount } = mountPanel({ put })
    await settle()

    toggle('alpha', true)
    await settle()

    expect(toasts.errors).toEqual(['Not allowed to manage skills'])
    expect(switchIn('alpha').props.checked).toBe(false)
    unmount()
  })

  test('US-007 AC6 (disable): when disable rejects, the panel toasts the message and the switch shows on again', async () => {
    const del = jest.fn(async () => { throw new ApiError(500, 'Disable failed') })
    const { switchIn, toggle, toasts, settle, unmount } = mountPanel({ del })
    await settle()

    toggle('beta', false)
    await settle()

    expect(toasts.errors).toEqual(['Disable failed'])
    expect(switchIn('beta').props.checked).toBe(true)
    unmount()
  })

  test('US-007 AC7: when the viewer cannot manage, every switch is disabled', async () => {
    const { switchIn, settle, unmount } = mountPanel({ canManage: false })
    await settle()

    expect(switchIn('alpha').props.disabled).toBe(true)
    expect(switchIn('beta').props.disabled).toBe(true)
    unmount()
  })

  test('US-007 AC7 (control): when the viewer can manage, switches are enabled', async () => {
    const { switchIn, settle, unmount } = mountPanel({ canManage: true })
    await settle()

    expect(switchIn('alpha').props.disabled).toBe(false)
    unmount()
  })

  test('US-007 AC8: a RESOLVE_FAILED source row renders the skills.project.sourceFailed warning', async () => {
    const { app, settle, unmount } = mountPanel({
      items: [skill('alpha', { source: { id: 's', gitUrl: 'u', ref: 'main', resolvedSha: null, status: 'RESOLVE_FAILED' } })],
    })
    await settle()

    expect(app.textOf(app.find('[data-testid="skill-row-alpha"]')[0])).toContain(enI18n().t('skills.project.sourceFailed'))
    unmount()
  })

  test('US-007 AC8 (control): an OK source row renders no source warning', async () => {
    const { app, settle, unmount } = mountPanel({ items: [skill('alpha')] })
    await settle()

    expect(app.text()).not.toContain(enI18n().t('skills.project.sourceFailed'))
    unmount()
  })

  test('US-007 AC7 (error path): a failed viewer-role fetch toasts its message and keeps every switch disabled', async () => {
    // On failure the composable's default is canManage false, so mount the failed state as it really is.
    const { switchIn, toasts, settle, unmount } = mountPanel({ canManage: false, viewerError: new ApiError(500, 'Members unavailable') })
    await settle()

    expect(toasts.errors).toEqual(['Members unavailable'])
    expect(switchIn('alpha').props.disabled).toBe(true)
    unmount()
  })

  test('US-007 AC7 (control): a successful viewer-role fetch toasts nothing', async () => {
    const { toasts, settle, unmount } = mountPanel({ canManage: true })
    await settle()

    expect(toasts.errors).toEqual([])
    unmount()
  })

  test('US-007 (source context): each row shows the source git URL and ref', async () => {
    const { app, settle, unmount } = mountPanel({
      items: [skill('alpha', { source: { id: 's', gitUrl: 'https://github.com/o/alpha-skills', ref: 'release/v2', resolvedSha: null, status: 'OK' } })],
    })
    await settle()

    const row = app.textOf(app.find('[data-testid="skill-row-alpha"]')[0])
    expect(row).toContain('https://github.com/o/alpha-skills')
    expect(row).toContain('release/v2')
    unmount()
  })

  test('US-007 (error path): a failed list toasts the API message and renders no rows', async () => {
    const list = jest.fn(async () => { throw new ApiError(500, 'Skills unavailable') })
    const { rows, toasts, settle, unmount } = mountPanel({ list })
    await settle()

    expect(toasts.errors).toEqual(['Skills unavailable'])
    expect(rows()).toHaveLength(0)
    unmount()
  })
})
