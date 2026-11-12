import { describe, expect, jest, test } from '@jest/globals'
import { defineComponent, h, ref } from 'vue'
import { mountSfc, webFile } from '../helpers/mount-sfc'
import { i18nStub, toastRecorder, uiStubs } from '../helpers/fleet-harness'
import * as apiModule from '../../composables/useApi'

function mountPage() {
  let count = 0
  const project = { id: 'p1', name: 'Web', slug: 'web', key: 'WEB' }
  return mountSfc(webFile('pages', '[project]', 'settings.vue'), {
    components: {
      ...uiStubs,
      SettingsProjectCard: uiStubs.Button,
      ProjectMembersPanel: uiStubs.Button,
      ProjectInvitesPanel: uiStubs.Button,
      SettingsProviderKeysCard: uiStubs.Button,
      SettingsMemoryCard: defineComponent({ setup: () => () => h('memory-card', { 'data-testid': 'settings-memory' }) }),
      SettingsVcsCard: uiStubs.Button,
      ProjectSkillsPanel: uiStubs.Button,
      SettingsKnowledgeCard: uiStubs.Button,
    },
    alias: { '~/composables/useApi': apiModule },
    globals: {
      useApi: () => ({ $api: { get: jest.fn(async () => project) } }),
      useI18n: () => i18nStub(), useAppToast: () => toastRecorder(),
      useRoute: () => ({ params: { project: 'web' } }),
      useAsyncData: () => {
        count += 1
        return { data: ref(count === 1 ? null : project), pending: ref(false), error: ref(null), refresh: jest.fn(async () => undefined) }
      },
    },
  })
}

describe('project settings page headings and danger zone', () => {
  test('AC-1: PageHeader title is Project Settings', () => {
    const app = mountPage()
    expect(app.one('[data-stub="page-header"]')?.props.title).toBe('projects.settings.title')
    app.unmount()
  })

  test('AC-2: project tab trigger reads General', () => {
    const app = mountPage()
    const trigger = app.find('[data-stub="tabs-trigger"]').find((node) => node.props.value === 'project')
    expect(trigger).toBeDefined()
    if (trigger) expect(app.textOf(trigger)).toBe('projects.settings.tab')
    app.unmount()
  })

  test('AC-3: project details card heading uses the new details title', () => {
    const app = mountPage()
    expect(app.text()).toContain('projects.settings.detailsTitle')
    app.unmount()
  })

  test('AC-4: danger zone is the final project tab child after memory', () => {
    const app = mountPage()
    const content = app.find('[data-stub="tabs-content"]')[0]
    expect(content).toBeDefined()
    if (!content) return
    const memory = app.find('[data-testid="settings-memory"]', content)[0]
    const danger = app.find('[data-testid="settings-danger-zone"]', content)[0]
    expect(memory).toBeDefined()
    expect(danger).toBeDefined()
    if (memory && danger) {
      expect(content.children[content.children.length - 1]).toBe(danger)
      expect(content.children.indexOf(danger)).toBeGreaterThan(content.children.indexOf(memory))
    }
    app.unmount()
  })
})
