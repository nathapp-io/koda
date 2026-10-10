import { describe, test, expect, jest, afterEach } from '@jest/globals'
import * as Vue from 'vue'
import { ref, computed, watch, nextTick } from 'vue'
import { mountSfc, webFile } from '../helpers/mount-sfc'
import { uiStubs, enI18n, toastRecorder } from '../helpers/fleet-harness'
import * as apiModule from '../../composables/useApi'

const settingsPage = webFile('pages', '[project]', 'settings.vue')

/** Records the slug each ProjectSkillsPanel receives, so the test can assert the wiring. */
const panelSpy = jest.fn()
const ProjectSkillsPanelStub = {
  name: 'StubProjectSkillsPanel',
  props: ['slug'],
  setup(props: { slug?: string }) {
    panelSpy(props.slug)
    return () => Vue.h('x-stub-stub', { 'data-stub': 'project-skills-panel', 'data-slug': props.slug ?? '' })
  },
}

const inert = (tag: string) => ({
  name: `Inert${tag}`,
  setup: () => () => Vue.h('x-stub-stub', { 'data-stub': tag }),
})

/** Keeps the trigger's `value` on its node, so the test can read the tab order. */
const valueStub = (tag: string) => ({
  name: `Value${tag}`,
  props: ['value'],
  setup(props: { value?: string }, { slots, attrs }: { slots: Record<string, (() => unknown) | undefined>; attrs: Record<string, unknown> }) {
    return () => Vue.h('x-stub-stub', { ...attrs, 'data-stub': tag, value: props.value }, slots.default?.() as never)
  },
})

function mountSettings() {
  return mountSfc(settingsPage, {
    components: {
      ...uiStubs,
      TabsTrigger: valueStub('tabs-trigger'),
      TabsContent: valueStub('tabs-content'),
      ProjectSkillsPanel: ProjectSkillsPanelStub,
      ProjectMembersPanel: inert('members'),
      ProjectInvitesPanel: inert('invites'),
      SettingsProjectCard: inert('project-card'),
      SettingsVcsCard: inert('vcs-card'),
      LoadingState: inert('loading'),
      ErrorState: inert('error'),
    },
    alias: { '~/composables/useApi': apiModule },
    globals: {
      ref, computed, watch, nextTick,
      useRoute: () => ({ params: { project: 'web' } }),
      useApi: () => ({ $api: { get: jest.fn(async () => ({})) } }),
      useI18n: () => enI18n(),
      useAppToast: () => toastRecorder(),
      useAsyncData: () => ({ data: ref(null), pending: ref(false), error: ref(null), refresh: jest.fn() }),
    },
  })
}

afterEach(() => {
  panelSpy.mockClear()
})

describe('settings page skills tab (US-007)', () => {
  test('US-007 AC1: renders three tab triggers, project, vcs and skills, in that order', () => {
    const app = mountSettings()

    const triggers = app.find('[data-stub="tabs-trigger"]').map((t) => t.props.value)
    expect(triggers).toEqual(['project', 'vcs', 'skills'])
    app.unmount()
  })

  test('US-007 AC1: the skills content renders ProjectSkillsPanel receiving the project slug', () => {
    const app = mountSettings()

    const panels = app.find('[data-stub="project-skills-panel"]')
    expect(panels).toHaveLength(1)
    expect(panelSpy).toHaveBeenCalledWith('web')
    expect(panels[0].props['data-slug']).toBe('web')
    app.unmount()
  })

  test('US-007 AC1 (control): the panel sits inside the skills tab content, not the project tab', () => {
    const app = mountSettings()

    const skillsContent = app.find('[data-stub="tabs-content"]').filter((c) => c.props.value === 'skills')
    expect(skillsContent).toHaveLength(1)
    expect(app.find('[data-stub="project-skills-panel"]', skillsContent[0])).toHaveLength(1)

    const projectContent = app.find('[data-stub="tabs-content"]').filter((c) => c.props.value === 'project')
    expect(app.find('[data-stub="project-skills-panel"]', projectContent[0])).toHaveLength(0)
    app.unmount()
  })
})
