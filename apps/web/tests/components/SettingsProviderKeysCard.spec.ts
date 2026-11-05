import { describe, test, expect, jest, afterEach } from '@jest/globals'
import { nextTick } from 'vue'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { mountSfc, webFile } from '../helpers/mount-sfc'
import type { Mounted } from '../helpers/mount-sfc'
import { uiStubs, i18nStub, toastRecorder } from '../helpers/fleet-harness'
import * as apiModule from '../../composables/useApi'
import { projectPermissionsStub } from '../helpers/permission-nav'

const cardFile = webFile('components', 'SettingsProviderKeysCard.vue')
const row = (overrides: Record<string, unknown> = {}) => ({ id: 'c1', scope: 'PROJECT', repoId: null, providerId: 'openrouter', name: 'Main', last4: '1234', fingerprint: 'abcdef012345', disabled: false, ...overrides })
const get = jest.fn(async (path: string): Promise<unknown> => path.endsWith('/fleet/repos') ? { records: [{ id: 'r1', owner: 'acme', name: 'app' }] } : { records: [row(), row({ id: 'c2', scope: 'REPO', repoId: 'r1', name: 'Repo key' })] })
const post = jest.fn(async (_path: string, _body?: unknown): Promise<unknown> => row())
const patch = jest.fn(async (_path: string, _body?: unknown): Promise<unknown> => row())
const remove = jest.fn(async (_path: string): Promise<unknown> => ({}))
const toast = toastRecorder()
async function flush() { for (let i = 0; i < 5; i++) await nextTick(); await new Promise(resolve => setTimeout(resolve, 0)); await nextTick() }
async function mountCard(keys: readonly string[] = ['project.credential.read', 'project.credential.create']): Promise<Mounted> {
  const app = mountSfc(cardFile, { props: { slug: 'web' }, components: uiStubs, alias: { '~/composables/useApi': apiModule }, globals: { useApi: () => ({ $api: { get, post, patch, delete: remove } }), useI18n: () => i18nStub(), useAppToast: () => toast, useProjectPermissions: () => projectPermissionsStub(keys) } })
  await flush(); return app
}
const node = (app: Mounted, id: string) => app.find(`[data-testid="${id}"]`)[0]
afterEach(() => { get.mockClear(); post.mockClear(); patch.mockClear(); remove.mockClear(); toast.errors.length = 0 })

describe('US-013 SettingsProviderKeysCard', () => {
  test('AC-1: displays project and repo credentials using their scope/repository grouping', async () => {
    const app = await mountCard()
    expect(app.text()).toContain('openrouter · Main')
    expect(app.text()).toContain('acme/app')
    expect(app.text()).toContain('openrouter · Repo key')
    expect(get).toHaveBeenCalledWith('/projects/web/provider-credentials', expect.anything())
    app.unmount()
  })
  test('AC-8: hides add without create permission', async () => {
    const app = await mountCard(['project.credential.read'])
    expect(node(app, 'provider-key-add')).toBeUndefined()
    app.unmount()
  })
  test('project card copy exists in both locales', () => {
    for (const locale of ['en', 'zh']) {
      const messages = JSON.parse(readFileSync(join(__dirname, '../../i18n/locales', `${locale}.json`), 'utf8'))
      expect(messages.fleet.providerKeys.projectTitle).toBeDefined()
      expect(messages.fleet.providerKeys.projectDescription).toBeDefined()
      expect(messages.fleet.providerKeys.noReadPermission).toBeDefined()
      expect(messages.fleet.providerKeys.validation.repoRequired).toBeDefined()
    }
  })
})
