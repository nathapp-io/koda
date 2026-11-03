import { describe, test, expect, jest, afterEach } from '@jest/globals'
import { nextTick } from 'vue'
import { mountSfc, webFile } from '../helpers/mount-sfc'
import type { FakeNode, Mounted } from '../helpers/mount-sfc'
import { uiStubs, i18nStub, toastRecorder } from '../helpers/fleet-harness'
import * as apiModule from '../../composables/useApi'
import { projectPermissionsStub } from '../helpers/permission-nav'

const cardFile = webFile('components', 'SettingsMemoryCard.vue')
const writeMode = (mode: 'direct' | 'proposal', policy: { id: string; mode: string } | null = null) => ({
  mode, policyId: null, source: 'default', agentPolicy: policy,
})
const get = jest.fn(async (_path: string): Promise<unknown> => writeMode('direct'))
const post = jest.fn(async (_path: string, _body?: unknown): Promise<unknown> => ({}))
const patch = jest.fn(async (_path: string, _body?: unknown): Promise<unknown> => ({}))
const remove = jest.fn(async (_path: string): Promise<unknown> => ({}))
const toast = toastRecorder()

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await nextTick()
  await new Promise((resolve) => setTimeout(resolve, 0))
  await nextTick()
}

async function mountCard(keys: readonly string[] = ['approval.policy.manage']): Promise<Mounted> {
  const app = mountSfc(cardFile, {
    props: { slug: 'web' }, components: uiStubs,
    alias: { '~/composables/useApi': apiModule },
    globals: {
      useApi: () => ({ $api: { get, post, patch, delete: remove } }),
      useI18n: () => i18nStub(), useAppToast: () => toast,
      useProjectPermissions: () => projectPermissionsStub(keys),
    },
  })
  await flush()
  return app
}

const byId = (app: Mounted, id: string): FakeNode | undefined => app.find(`[data-testid="${id}"]`)[0]
async function click(app: Mounted, id: string): Promise<void> {
  const button = byId(app, id)
  expect(button).toBeDefined()
  await (button?.props.onClick as () => Promise<void> | void)()
  await flush()
}

afterEach(() => {
  get.mockReset().mockImplementation(async () => writeMode('direct'))
  post.mockReset().mockImplementation(async () => ({}))
  patch.mockReset().mockImplementation(async () => ({}))
  remove.mockReset().mockImplementation(async () => ({}))
  toast.errors.length = 0
})

describe('US-009 SettingsMemoryCard', () => {
  test('AC-1: reads the project write mode and selects direct when there is no agent policy', async () => {
    const app = await mountCard()
    expect(get).toHaveBeenCalledWith('/projects/web/memory/write-mode')
    expect(byId(app, 'memory-mode-direct')?.props['aria-pressed']).toBe(true)
    expect(byId(app, 'memory-mode-proposal')?.props['aria-pressed']).toBe(false)
    app.unmount()
  })

  test('AC-2: creates the exact AGENT policy and reloads write mode', async () => {
    const app = await mountCard()
    await click(app, 'memory-mode-proposal')
    expect(post).toHaveBeenCalledWith('/projects/web/approval-policies', {
      permissionPattern: 'memory.create', appliesTo: { kind: 'type', principalType: 'AGENT' }, mode: 'human',
    })
    expect(get).toHaveBeenCalledTimes(2)
    app.unmount()
  })

  test('AC-3: promotes an existing none policy by patching its id, never posting', async () => {
    get.mockImplementation(async () => writeMode('direct', { id: 'pol1', mode: 'none' }))
    const app = await mountCard()
    await click(app, 'memory-mode-proposal')
    expect(patch).toHaveBeenCalledWith('/projects/web/approval-policies/pol1', { mode: 'human' })
    expect(post).not.toHaveBeenCalled()
    app.unmount()
  })

  test('AC-4: selects proposal for an enabled agent policy and deletes it to choose direct', async () => {
    get.mockImplementation(async () => writeMode('proposal', { id: 'pol1', mode: 'human' }))
    const app = await mountCard()
    expect(byId(app, 'memory-mode-proposal')?.props['aria-pressed']).toBe(true)
    await click(app, 'memory-mode-direct')
    expect(remove).toHaveBeenCalledWith('/projects/web/approval-policies/pol1')
    expect(get).toHaveBeenCalledTimes(2)
    app.unmount()
  })

  test('AC-5: denies both controls and all writes without approval.policy.manage', async () => {
    const app = await mountCard([])
    expect(byId(app, 'memory-mode-direct')?.props.disabled).toBe(true)
    expect(byId(app, 'memory-mode-proposal')?.props.disabled).toBe(true)
    await click(app, 'memory-mode-proposal')
    expect(post).not.toHaveBeenCalled()
    expect(patch).not.toHaveBeenCalled()
    expect(remove).not.toHaveBeenCalled()
    app.unmount()
  })

  test('AC-6: failed creation reports extractApiError and rolls selection back to direct', async () => {
    post.mockRejectedValueOnce(new apiModule.ApiError(403, 'Creation refused'))
    const app = await mountCard()
    await click(app, 'memory-mode-proposal')
    expect(app.text()).toContain(apiModule.extractApiError(new apiModule.ApiError(403, 'Creation refused')))
    expect(byId(app, 'memory-mode-direct')?.props['aria-pressed']).toBe(true)
    app.unmount()
  })

  test('AC-8: failed patch reports API error and restores API-reported direct mode', async () => {
    get.mockImplementation(async () => writeMode('direct', { id: 'pol1', mode: 'none' }))
    patch.mockRejectedValueOnce(new apiModule.ApiError(403, 'Patch refused'))
    const app = await mountCard()
    await click(app, 'memory-mode-proposal')
    expect(app.text()).toContain(apiModule.extractApiError(new apiModule.ApiError(403, 'Patch refused')))
    expect(byId(app, 'memory-mode-direct')?.props['aria-pressed']).toBe(true)
    app.unmount()
  })

  test('AC-9: failed deletion reports API error and restores API-reported proposal mode', async () => {
    get.mockImplementation(async () => writeMode('proposal', { id: 'pol1', mode: 'human' }))
    remove.mockRejectedValueOnce(new apiModule.ApiError(403, 'Delete refused'))
    const app = await mountCard()
    await click(app, 'memory-mode-direct')
    expect(app.text()).toContain(apiModule.extractApiError(new apiModule.ApiError(403, 'Delete refused')))
    expect(byId(app, 'memory-mode-proposal')?.props['aria-pressed']).toBe(true)
    app.unmount()
  })
})
