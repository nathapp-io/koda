import { describe, expect, jest, test } from '@jest/globals'
import { defineComponent, h, ref } from 'vue'
import { mountSfc, webFile } from '../helpers/mount-sfc'
import { enI18n, uiStubs } from '../helpers/fleet-harness'
import { settle } from '../helpers/roles-dom'

/**
 * US-002 AC-7 to AC-9: a comment body is rendered as image-free markdown.
 *
 * `~/lib/markdown` is aliased to a stub (jest cannot load `isomorphic-dompurify`, see
 * `tests/lib/markdown.spec.ts`), so the mount observes *what the component asks the renderer for*
 * and where the answer lands. The real renderer itself is covered by the real-stack harness
 * `tests/harness/markdown-without-images-real-sanitizer.ts`.
 */

const ADA = 'c000000000000000000000009'
const COMMENT = { id: 'c1', body: `hi @[Old](user:${ADA})`, type: 'GENERAL', createdAt: '2026-11-10T14:07:45.657Z' }

const MarkdownEditor = defineComponent({
  props: { modelValue: String },
  emits: ['update:modelValue'],
  setup(_props, { attrs }) {
    return () => h('textarea', attrs)
  },
})

function mountThread() {
  const rendered = '<p class="stub-rendered">hi <span class="mention-chip">@Ada</span></p>'
  const renderMarkdownWithoutImages = jest.fn((_markdown: string, _options?: { breaks?: boolean }) => rendered)
  const app = mountSfc(webFile('components', 'CommentThread.vue'), {
    props: { projectSlug: 'proj', ticketRef: 'ABC-1' },
    components: { ...uiStubs, MarkdownEditor },
    alias: { '~/lib/markdown': { renderMarkdownWithoutImages } },
    globals: {
      useApi: () => ({ $api: { get: async () => [COMMENT], post: async () => ({}), patch: async () => ({}), delete: async () => ({}) } }),
      useI18n: () => enI18n(),
      useAppToast: () => ({ success: () => undefined, error: () => undefined }),
      useProjectMemberNames: () => ({
        members: ref([]),
        load: async () => undefined,
        nameOf: (id: string) => (id === ADA ? 'Ada' : null),
      }),
      useAsyncData: () => ({ data: ref([COMMENT]), pending: ref(false), error: ref(null), refresh: async () => undefined }),
    },
  })
  return { app, rendered, renderMarkdownWithoutImages }
}

describe('US-002: a comment body renders as image-free markdown', () => {
  test('AC-7: the mention-chipped body and { breaks: true } are handed to renderMarkdownWithoutImages', async () => {
    const { app, renderMarkdownWithoutImages } = mountThread()
    await settle()

    expect(renderMarkdownWithoutImages).toHaveBeenCalledWith('hi <span class="mention-chip">@Ada</span>', { breaks: true })
    app.unmount()
  })

  test('AC-8: the comment body element holds exactly the HTML the renderer returned', async () => {
    const { app, rendered } = mountThread()
    await settle()

    const body = app.find('[data-testid="comment-body"]')
    expect(body).toHaveLength(1)
    expect(body[0].props.innerHTML).toBe(rendered)
    app.unmount()
  })

  test('AC-9: the comment body element carries the markdown-body class', async () => {
    const { app } = mountThread()
    await settle()

    const body = app.find('[data-testid="comment-body"]')
    expect(body).toHaveLength(1)
    expect(String(body[0].props.class).split(/\s+/)).toContain('markdown-body')
    app.unmount()
  })
})
