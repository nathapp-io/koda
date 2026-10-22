/**
 * Permissions P1 US-013: the settings page renders the members panel with the project's id.
 *
 * The panel binds project roles, so `POST /role-bindings` needs the project id — which only exists
 * once `GET /projects/:slug` has answered. The panel is therefore mounted with the project, not
 * beside it, and this spec pins that timing: absent while the project is loading, present with both
 * props once it resolves.
 */
import { describe, expect, jest, test } from '@jest/globals'
import { nextTick, ref } from 'vue'
import { h } from 'vue'
import { mountSfc, webFile } from '../helpers/mount-sfc'
import { enI18n, toastRecorder, uiStubs } from '../helpers/fleet-harness'
import * as apiModule from '../../composables/useApi'
import type { Mounted } from '../helpers/mount-sfc'

const settingsPath = webFile('pages', '[project]', 'settings.vue')

const panelProps: Array<Record<string, unknown>> = []
const membersPanelStub = {
  name: 'StubProjectMembersPanel',
  props: ['slug', 'projectId'],
  setup(props: Record<string, unknown>) {
    panelProps.push({ ...props })
    return () => h('x-stub-stub', { 'data-stub': 'members-panel', 'data-slug': props.slug ?? '', 'data-project-id': props.projectId ?? '' })
  },
}

const inert = (tag: string) => ({ name: `Inert${tag}`, setup: () => () => h('x-stub-stub', { 'data-stub': tag }) })

async function settle(): Promise<void> {
  for (let i = 0; i < 8; i += 1) {
    await new Promise<void>((resolve) => { setTimeout(resolve, 0) })
    await nextTick()
  }
}

async function mountSettings(project: { loading: boolean; data: unknown }): Promise<Mounted> {
  const app = mountSfc(settingsPath, {
    components: {
      ...uiStubs,
      ProjectMembersPanel: membersPanelStub,
      ProjectInvitesPanel: inert('invites'),
      SettingsProjectCard: inert('project-card'),
      SettingsVcsCard: inert('vcs-card'),
      SettingsKnowledgeCard: inert('knowledge-card'),
      ProjectSkillsPanel: inert('skills-panel'),
      LoadingState: inert('loading'),
      ErrorState: inert('error'),
    },
    alias: { '~/composables/useApi': apiModule },
    globals: {
      useRoute: () => ({ params: { project: 'web' } }),
      useApi: () => ({ $api: { get: jest.fn(async () => ({})) } }),
      useI18n: () => enI18n(),
      useAppToast: () => toastRecorder(),
      useAsyncData: () => ({
        data: ref(project.data), pending: ref(project.loading), error: ref(null), refresh: jest.fn(),
      }),
    },
  })
  await settle()
  return app
}

describe('settings page members panel wiring (US-013)', () => {
  test('AC-1 wiring: the panel receives the slug and the loaded project id', async () => {
    panelProps.length = 0
    const app = await mountSettings({ loading: false, data: { id: 'p1', name: 'Web', slug: 'web', key: 'WEB' } })

    const panels = app.find('[data-stub="members-panel"]')
    expect(panels).toHaveLength(1)
    expect(panels[0]?.props['data-slug']).toBe('web')
    expect(panels[0]?.props['data-project-id']).toBe('p1')
    app.unmount()
  })

  test('AC-1 wiring boundary: no panel while the project is still loading', async () => {
    panelProps.length = 0
    const app = await mountSettings({ loading: true, data: null })

    expect(app.find('[data-stub="members-panel"]')).toHaveLength(0)
    app.unmount()
  })
})
