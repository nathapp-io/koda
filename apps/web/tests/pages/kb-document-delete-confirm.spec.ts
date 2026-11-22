import { describe, expect, jest, test } from '@jest/globals'
import * as Vue from 'vue'
import { mountSfc, webFile } from '../helpers/mount-sfc'
import type { FakeNode } from '../helpers/mount-sfc'
import { enI18n, uiStubs } from '../helpers/fleet-harness'

const source = webFile('pages', '[project]', 'kb.vue')
const document = { id: 'd1', source: 'DOC', sourceId: 'doc-1', content: 'Indexed content', createdAt: '2026-01-01T00:00:00.000Z' }
const flush = async (): Promise<void> => {
  for (let i = 0; i < 6; i += 1) {
    await new Promise<void>((resolve) => { setImmediate(resolve) })
    await Vue.nextTick()
  }
}

function mountPage(confirmAnswer = true) {
  const api = { get: jest.fn(async () => ({ items: [document] })), post: jest.fn(), delete: jest.fn(async () => undefined) }
  const confirm = jest.fn(async () => confirmAnswer)
  const refresh = jest.fn(async () => undefined)
  const app = mountSfc(source, {
    components: uiStubs,
    globals: {
      useApi: () => ({ $api: api }),
      useRoute: () => ({ params: { project: 'demo' } }),
      useI18n: () => enI18n(),
      useAppToast: () => ({ success: jest.fn(), error: jest.fn() }),
      useConfirm: () => ({ confirm }),
      useAsyncData: () => ({ data: Vue.ref({ items: [document] }), pending: Vue.ref(false), error: Vue.ref(null), refresh }),
    },
  })
  return { app, api, confirm }
}

async function deleteDocument(app: ReturnType<typeof mountPage>['app']): Promise<void> {
  const button = app.find('[data-stub="button"]').find(node => app.textOf(node) === 'Delete') as FakeNode | undefined
  if (!button) throw new Error('document delete button not found')
  ;(button.props.onClick as (() => unknown) | undefined)?.()
  await flush()
}

describe('KB document delete confirmation', () => {
  test('AC-5 requests complete destructive confirmation options', async () => {
    const m = mountPage()
    await flush()
    await deleteDocument(m.app)
    expect(m.confirm).toHaveBeenCalledTimes(1)
    expect(m.confirm).toHaveBeenCalledWith({
      title: enI18n().t('kb.documents.deleteConfirm'),
      body: enI18n().t('kb.documents.deleteConfirmBody'),
      confirmLabel: enI18n().t('common.delete'),
      destructive: true,
    })
  })

  test('AC-6 declining confirmation sends no document delete request', async () => {
    const m = mountPage(false)
    await flush()
    await deleteDocument(m.app)
    expect(m.api.delete).not.toHaveBeenCalled()
  })
})
