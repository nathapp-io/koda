import { describe, expect, test } from '@jest/globals'
import { computed, ref } from 'vue'
import { mountSfc, webFile } from '../helpers/mount-sfc'
import { enI18n, uiStubs } from '../helpers/fleet-harness'

function mountKb() {
  return mountSfc(webFile('pages', '[project]', 'kb.vue'), {
    components: uiStubs,
    globals: {
      useRoute: () => ({ params: { project: 'acme' } }), useI18n: () => ({ ...enI18n(), locale: ref('en') }),
      useAppToast: () => ({ error: () => undefined, success: () => undefined }),
      useApi: () => ({ $api: { post: async () => ({}), get: async () => ({ items: [] }), delete: async () => undefined } }),
      useAsyncData: () => ({ data: ref({ items: [] }), pending: ref(false), error: ref(null), refresh: async () => undefined }),
      apiPath: (parts: TemplateStringsArray, ...values: string[]) => parts.reduce((s, p, i) => s + p + (values[i] ?? ''), ''),
      computed, ref, definePageMeta: () => undefined,
    },
  })
}

describe('KB empty states', () => {
  test('AC-9 shows an instructional pre-search prompt without repeating the input placeholder', () => {
    const app = mountKb()
    expect(app.text()).toContain("Search this project's knowledge")
    expect(app.text()).toContain('Type a question or keywords above and press Search.')
    expect(app.text()).not.toContain('Search the knowledge base...')
    app.unmount()
  })

  test('AC-10 shows an instructional hint when the documents tab is selected', async () => {
    const app = mountKb()
    const tab = app.find('[value="documents"]')[0]
    tab?.props.onClick?.()
    await Promise.resolve()
    expect(app.text()).toContain('No documents yet.')
    expect(app.text()).toContain('Add a document to make it searchable.')
    app.unmount()
  })
})
