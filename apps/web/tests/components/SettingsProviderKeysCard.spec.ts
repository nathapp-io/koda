import { describe, test, expect, jest, afterEach } from '@jest/globals'
import { nextTick } from 'vue'
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
async function mountCard(keys: readonly string[] = ['project.credential.read', 'project.credential.create', 'project.credential.update', 'project.credential.delete']): Promise<Mounted> {
  const app = mountSfc(cardFile, { props: { slug: 'web' }, components: uiStubs, alias: { '~/composables/useApi': apiModule }, globals: { useApi: () => ({ $api: { get, post, patch, delete: remove } }), useI18n: () => i18nStub(), useAppToast: () => toast, useProjectPermissions: () => projectPermissionsStub(keys), confirm: () => true } })
  await flush(); return app
}
const node = (app: Mounted, id: string) => app.find(`[data-testid="${id}"]`)[0]
async function click(app: Mounted, id: string) { const el = node(app, id); expect(el).toBeDefined(); await (el?.props.onClick as () => Promise<void> | void)(); await flush() }
afterEach(() => { get.mockClear(); post.mockClear(); patch.mockClear(); remove.mockClear(); toast.errors.length = 0 })

describe('US-013 SettingsProviderKeysCard', () => {
  test('AC-1: lists project and repo rows grouped under project and actual repo name', async () => { const app = await mountCard(); expect(app.text()).toContain('Project'); expect(app.text()).toContain('acme/app'); expect(app.text()).toContain('Main'); expect(app.text()).toContain('Repo key'); app.unmount() })
  test('AC-2: adds project key without repoId', async () => { const app = await mountCard(); await click(app, 'provider-key-add'); expect(post).toHaveBeenCalledWith('/projects/web/provider-credentials', { providerId: 'openrouter', name: 'New key', key: 'sk-live-0123456789abcdef' }); app.unmount() })
  test('AC-3: adds repo key with selected repoId', async () => { const app = await mountCard(); await click(app, 'provider-key-scope-repo'); await click(app, 'provider-key-add'); expect(post).toHaveBeenCalledWith('/projects/web/provider-credentials', { providerId: 'openrouter', name: 'New key', key: 'sk-live-0123456789abcdef', repoId: 'r1' }); app.unmount() })
  test('AC-4/5: rotate sends key only and disable sends disabled only', async () => { const app = await mountCard(); await click(app, 'provider-key-rotate-c1'); expect(patch).toHaveBeenCalledWith('/projects/web/provider-credentials/c1', { key: 'sk-live-0123456789abcdef' }); patch.mockClear(); await click(app, 'provider-key-disable-c1'); expect(patch).toHaveBeenCalledWith('/projects/web/provider-credentials/c1', { disabled: true }); app.unmount() })
  test('AC-6: delete only follows accepted confirmation', async () => { const app = await mountCard(); await click(app, 'provider-key-delete-c1'); expect(remove).toHaveBeenCalledWith('/projects/web/provider-credentials/c1'); app.unmount() })
  test('AC-7: pending write shows notice without adding credential row', async () => { post.mockResolvedValueOnce({ permissionKey: 'project.credential.create', id: 'approval' }); const app = await mountCard(); await click(app, 'provider-key-add'); expect(app.text()).toContain('Pending approval'); expect(app.text()).not.toContain('New key'); app.unmount() })
  test('AC-8: hides add without create permission', async () => { const app = await mountCard(['project.credential.read']); expect(node(app, 'provider-key-add')).toBeUndefined(); app.unmount() })
  test('AC-9: refused write surfaces extracted error in toast', async () => { post.mockRejectedValueOnce(new apiModule.ApiError(403, 'Refused')); const app = await mountCard(); await click(app, 'provider-key-add'); expect(toast.errors).toContain(apiModule.extractApiError(new apiModule.ApiError(403, 'Refused'))); app.unmount() })
})
