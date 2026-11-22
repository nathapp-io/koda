import { afterEach, describe, expect, jest, test } from '@jest/globals'
import { mountSfc, webFile } from '../helpers/mount-sfc'
import type { FakeNode } from '../helpers/mount-sfc'
import { i18nStub, toastRecorder, uiStubs } from '../helpers/fleet-harness'
import * as apiModule from '../../composables/useApi'

const file = webFile('components', 'SettingsDangerZoneCard.vue')
const deleted = jest.fn<(...args: unknown[]) => Promise<unknown>>(async () => ({}))
const push = jest.fn<(...args: unknown[]) => Promise<void>>(async () => undefined)
const success = jest.fn()
const error = jest.fn()

const confirm = jest.fn<(...args: unknown[]) => Promise<boolean>>(async () => true)

function mount(confirmed: boolean, reject = false) {
  confirm.mockResolvedValue(confirmed)
  deleted.mockImplementation(reject ? async () => { throw new Error('delete failed') } : async () => ({}))
  const toast = { ...toastRecorder(), success, error }
  return mountSfc(file, {
    props: { project: { id: 'p1', name: 'Web', slug: 'web', key: 'WEB' } },
    components: uiStubs,
    alias: { '~/composables/useApi': apiModule },
    globals: {
      useApi: () => ({ $api: { delete: deleted } }),
      useI18n: () => i18nStub(), useAppToast: () => toast,
      useRouter: () => ({ push }),
      useConfirm: () => ({ confirm }),
    },
  })
}

afterEach(() => { deleted.mockClear(); push.mockClear(); success.mockClear(); error.mockClear(); jest.restoreAllMocks() })

describe('SettingsDangerZoneCard', () => {
  test('AC-6: renders Danger zone and the Delete Project button', () => {
    const app = mount(true)
    expect(app.text()).toContain('projects.settings.dangerZone.title')
    const button = app.one('[data-testid="project-delete"]')
    expect(button).toBeDefined()
    expect(app.textOf(button as FakeNode)).toContain('projects.settings.delete')
    app.unmount()
  })

  test('AC-7: confirms, deletes the project, shows success and navigates home', async () => {
    const app = mount(true)
    await (app.one('[data-testid="project-delete"]')?.props.onClick as () => Promise<void>)()
    expect(confirm).toHaveBeenCalledWith({ title: 'projects.settings.deleteConfirm', body: 'projects.settings.deleteConfirmBody', confirmLabel: 'projects.settings.delete', destructive: true })
    expect(deleted).toHaveBeenCalledWith('/projects/web')
    expect(success).toHaveBeenCalledWith('projects.settings.deleted')
    expect(push).toHaveBeenCalledWith('/')
    app.unmount()
  })

  test('AC-8: does not delete when confirmation is declined', async () => {
    const app = mount(false)
    await (app.one('[data-testid="project-delete"]')?.props.onClick as () => Promise<void>)()
    expect(deleted).not.toHaveBeenCalled()
    app.unmount()
  })

  test('AC-9: reports delete errors without navigating', async () => {
    const app = mount(true, true)
    await (app.one('[data-testid="project-delete"]')?.props.onClick as () => Promise<void>)()
    expect(error).toHaveBeenCalledWith('delete failed')
    expect(push).not.toHaveBeenCalled()
    app.unmount()
  })
})
