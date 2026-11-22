import { afterEach, describe, expect, jest, test } from '@jest/globals'
import { mountSfc, webFile, type Mounted } from '../helpers/mount-sfc'
import { i18nStub, uiStubs } from '../helpers/fleet-harness'
import * as apiModule from '../../composables/useApi'

const confirm = jest.fn(async () => false)
const post = jest.fn(async () => ({ webhookSecret: 'secret' }))
function mount(): Mounted {
  return mountSfc(webFile('components', 'SettingsVcsCard.vue'), {
    props: { connection: { provider: 'github', repoOwner: 'acme', repoName: 'app', syncMode: 'webhook', pollingIntervalMs: 600000, allowedAuthors: [] } },
    components: uiStubs,
    alias: { '~/composables/useApi': apiModule },
    globals: {
      useApi: () => ({ $api: { post } }),
      useRoute: () => ({ params: { project: 'web' } }),
      useI18n: () => i18nStub(),
      useAppToast: () => ({ success: jest.fn(), error: jest.fn() }),
      useConfirm: () => ({ confirm }),
    },
  })
}

afterEach(() => { confirm.mockReset().mockResolvedValue(false); post.mockClear() })

describe('SettingsVcsCard rotate confirmation', () => {
  test('AC-1: rotate sends the exact destructive dialog options', async () => {
    const app = mount()
    const button = app.find('[data-stub="button"]').find(node => app.textOf(node).includes('vcs.secret.rotate'))
    expect(button).toBeDefined()
    await (button?.props.onClick as () => Promise<void>)()
    expect(confirm).toHaveBeenCalledTimes(1)
    expect(confirm).toHaveBeenCalledWith({ title: 'vcs.secret.rotateConfirm', body: 'vcs.secret.rotateConfirmBody', confirmLabel: 'vcs.secret.rotate', destructive: true })
    expect(post).not.toHaveBeenCalled()
    app.unmount()
  })

  test('AC-2: declining the dialog sends no secret rotation POST', async () => {
    confirm.mockResolvedValue(false)
    const app = mount()
    const button = app.find('[data-stub="button"]').find(node => app.textOf(node).includes('vcs.secret.rotate'))
    await (button?.props.onClick as () => Promise<void>)()
    expect(post).not.toHaveBeenCalled()
    app.unmount()
  })
})
