import { describe, expect, test } from '@jest/globals'
import { defineComponent, h, ref } from 'vue'
import { mountSfc, webFile } from '../helpers/mount-sfc'
import { enI18n, uiStubs } from '../helpers/fleet-harness'
import { settle } from '../helpers/roles-dom'

/**
 * US-002 AC-10 and AC-11: the ticket description and the editor preview carry the same
 * `markdown-body` styling hook the comment body does.
 *
 * `~/lib/markdown` is aliased to a stub: jest cannot load `isomorphic-dompurify` (see
 * `tests/lib/markdown.spec.ts`), and these tests are about the container, not the rendering.
 */

const markdownStub = {
  renderMarkdownOrEscape: (markdown: string) => `<p>${markdown}</p>`,
  renderMarkdownWithoutImages: (markdown: string) => `<p>${markdown}</p>`,
}

const MarkdownEditor = defineComponent({
  props: { modelValue: String },
  emits: ['update:modelValue'],
  setup(_props, { attrs }) {
    return () => h('textarea', attrs)
  },
})

/** The real `CommentThread.vue` mounts as a child (TicketActivity imports it explicitly), so its auto-imports are here too. */
function mountActivity() {
  return mountSfc(webFile('components', 'TicketActivity.vue'), {
    props: {
      ticket: { id: 't1', description: '**bold** and a [link](https://e.com)' },
      projectSlug: 'proj',
      ticketRef: 'ABC-1',
      editing: false,
      editDescription: '',
    },
    components: { ...uiStubs, MarkdownEditor },
    alias: { '~/lib/markdown': markdownStub },
    globals: {
      useApi: () => ({ $api: { get: async () => [], post: async () => ({}), patch: async () => ({}), delete: async () => ({}) } }),
      useI18n: () => enI18n(),
      useAppToast: () => ({ success: () => undefined, error: () => undefined }),
      useProjectMemberNames: () => ({ members: ref([]), load: async () => undefined, nameOf: () => null }),
      useAsyncData: () => ({ data: ref([]), pending: ref(false), error: ref(null), refresh: async () => undefined }),
    },
  })
}

describe('US-002: the ticket description carries the markdown-body styling hook', () => {
  test('AC-10: a rendered description is shown in a markdown-body container', async () => {
    const app = mountActivity()
    await settle()

    const description = app.find('[data-testid="ticket-description-body"]')
    expect(description).toHaveLength(1)
    expect(String(description[0].props.class).split(/\s+/)).toContain('markdown-body')
    expect(description[0].props.innerHTML).toContain('<p>')
    app.unmount()
  })
})

describe('US-002: the editor preview carries the markdown-body styling hook', () => {
  test('AC-11: the preview pane of a mounted MarkdownEditor is a markdown-body container', async () => {
    const app = mountSfc(webFile('components', 'MarkdownEditor.vue'), {
      props: { modelValue: 'hello markdown' },
      components: uiStubs,
      alias: {
        '~/lib/markdown': markdownStub,
        // The real tab parts are radix-vue; the stubs render every content slot, which is what a
        // preview assertion needs.
        '~/components/ui/tabs': { Tabs: uiStubs.Tabs, TabsList: uiStubs.TabsList, TabsTrigger: uiStubs.TabsTrigger, TabsContent: uiStubs.TabsContent },
        '~/components/ui/textarea': { Textarea: uiStubs.Textarea },
      },
      globals: { useI18n: () => enI18n() },
    })
    await settle()

    const preview = app.find('[data-testid="markdown-preview"]')
    expect(preview).toHaveLength(1)
    expect(String(preview[0].props.class).split(/\s+/)).toContain('markdown-body')
    app.unmount()
  })
})
