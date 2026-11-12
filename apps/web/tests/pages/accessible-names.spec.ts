import { describe, expect, jest, test } from '@jest/globals'
import { computed, ref } from 'vue'
import { readFileSync } from 'fs'
import { join } from 'path'
import { mountSfc, webFile } from '../helpers/mount-sfc'
import { enI18n, toastRecorder, uiStubs } from '../helpers/fleet-harness'
import type { NotificationPreferenceDto } from '~/lib/notification-types'
import type { HomeProject } from '~/lib/home-types'

const webRoot = join(__dirname, '..', '..')
const notificationPage = webFile('pages', 'settings', 'notifications.vue')
const sloPage = webFile('pages', 'admin', 'slos.vue')
const projectList = webFile('components', 'home', 'HomeProjectList.vue')
const preferences: NotificationPreferenceDto[] = [{ category: 'ASSIGNED', inApp: true, email: true }]
const settle = async () => { for (let i = 0; i < 6; i++) { await new Promise(resolve => setImmediate(resolve)); await import('vue').then(Vue => Vue.nextTick()) } }

function notifications(load: () => Promise<void> = async () => undefined) {
  const view = ref({ emailAvailable: true, emailEnabled: true, items: [] as NotificationPreferenceDto[] })
  const fake = { view, pending: ref(false), load: jest.fn(async () => { await load(); view.value.items = preferences }), setInApp: jest.fn(), setEmail: jest.fn(), setEmailEnabled: jest.fn() }
  const app = mountSfc(notificationPage, {
    components: uiStubs,
    alias: { '~/composables/useNotificationPreferences': { useNotificationPreferences: () => fake } },
    globals: { useI18n: () => enI18n(), useAppToast: () => toastRecorder(), definePageMeta: () => undefined },
  })
  return { app, fake }
}

describe('US-006 accessible names and attention chip', () => {
  test('email preference has a category-specific accessible name', async () => {
    const { app } = notifications()
    await settle()
    expect(app.one('[data-testid="notification-pref-email-ASSIGNED"]')?.props['aria-label']).toBe(`Email: ${enI18n().t('notifications.categories.ASSIGNED.label')}`)
    app.unmount()
  })

  test('both locales define the emailFor interpolation', () => {
    for (const locale of ['en', 'zh']) {
      const json = JSON.parse(readFileSync(join(webRoot, 'i18n', 'locales', `${locale}.json`), 'utf8')) as { notifications: { preferences: { emailFor: string } } }
      expect(json.notifications.preferences.emailFor).toContain('{category}')
    }
    const en = JSON.parse(readFileSync(join(webRoot, 'i18n/locales/en.json'), 'utf8')) as { notifications: { preferences: { emailFor: string } } }
    expect(en.notifications.preferences.emailFor).toBe('Email: {category}')
  })

  test.each([
    ['from', 'from'], ['to', 'to'],
  ])('%s date input is associated with its visible label', (suffix) => {
    const app = mountSfc(sloPage, {
      components: uiStubs,
      globals: { useI18n: () => enI18n(), useAppToast: () => toastRecorder(), definePageMeta: () => undefined, useApi: () => ({ $api: { get: async () => ({}) } }) },
    })
    const label = app.find('label').find(node => app.textOf(node) === enI18n().t(`slos.window.${suffix}`))
    const inputId = label?.props.for ?? label?.props.htmlFor
    const selected = app.find('input').find(node => node.props.id === inputId)
    expect(inputId).toBeTruthy()
    expect(selected?.props.type).toBe('date')
    app.unmount()
  })

  test('attention chip uses the contrast-safe card surface', () => {
    const project: HomeProject = { id: 'p1', name: 'Acme', key: 'ACME', slug: 'acme', description: 'Main', openTickets: 0, attentionJobs: 2 }
    const app = mountSfc(projectList, { components: uiStubs, props: { projects: [project] }, globals: { ref, computed, useI18n: () => enI18n() } })
    const chip = app.find('span').find(node => app.textOf(node) === '2 need attention')
    expect(chip?.props.class).toContain('bg-card')
    expect(chip?.props.class).toContain('text-status-rejected')
    expect(chip?.props.class).not.toContain('bg-destructive/10')
    app.unmount()
  })

  test('failed initial preference read keeps ErrorState after pending settles', async () => {
    const { app } = notifications(async () => { throw new Error('offline') })
    await settle()
    expect(app.find('[data-stub="error-state"]')).toHaveLength(1)
    expect(app.find('[data-testid="notification-pref-ASSIGNED"]')).toHaveLength(0)
    app.unmount()
  })
})
