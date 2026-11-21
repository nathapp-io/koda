import { describe, expect, jest, test } from '@jest/globals'
import { defineComponent, h, ref } from 'vue'
import { mountSfc, webFile } from '../helpers/mount-sfc'
import { enI18n, uiStubs } from '../helpers/fleet-harness'
import { settle } from '../helpers/roles-dom'

const comment = (author: Record<string, unknown> = {}) => ({ id: 'c1', body: 'hello', type: 'GENERAL', createdAt: '2026-11-10T14:07:45.657Z', ...author })

type Roster = { load: () => Promise<void>; nameOf: (id: string) => string | null | undefined }
function mountThread(options: {
  comment?: Record<string, unknown>
  member?: Roster
  agent?: Roster
  confirm?: (options: Record<string, unknown>) => Promise<boolean>
  delete?: () => Promise<unknown>
} = {}) {
  const comments = [options.comment ?? comment()]
  const api = { get: jest.fn(async () => comments), post: jest.fn(async () => ({})), patch: jest.fn(async () => ({})), delete: jest.fn(options.delete ?? (async () => ({}))) }
  const toast = { success: jest.fn(), error: jest.fn() }
  const confirm = options.confirm ?? jest.fn(async () => true)
  const app = mountSfc(webFile('components', 'CommentThread.vue'), {
    props: { projectSlug: 'proj', ticketRef: 'ABC-1' }, components: {
      ...uiStubs,
      MarkdownEditor: defineComponent({ setup: () => () => h('textarea') }),
    },
    alias: { '~/lib/markdown': { renderMarkdownWithoutImages: (markdown: string) => markdown } },
    globals: {
      useApi: () => ({ $api: api }), useI18n: () => enI18n(), useAppToast: () => toast,
      useProjectMemberNames: () => options.member ?? { load: async () => undefined, nameOf: () => null },
      useProjectAgentNames: () => options.agent ?? { load: async () => undefined, nameOf: () => null },
      useConfirm: () => ({ confirm }),
      useAsyncData: () => ({ data: ref(comments), pending: ref(false), error: ref(null), refresh: async () => undefined }),
    },
  })
  return { app, api, toast, confirm }
}

function authorText(app: ReturnType<typeof mountThread>['app']): string {
  const author = app.one('[data-testid="comment-author"]')
  return author ? app.textOf(author) : ''
}

describe('CommentThread recorded authors', () => {
  test('AC-1: shows the resolved member name', async () => {
    const { app } = mountThread({ comment: comment({ authorUserId: 'u1' }), member: { load: async () => undefined, nameOf: () => 'Ada' } })
    await settle(); expect(authorText(app)).toBe('Ada'); app.unmount()
  })
  test.each([['AC-2', null], ['AC-3', undefined]] as const)('%s: resolved roster with no name shows former member', async (_ac, name) => {
    const { app } = mountThread({ comment: comment({ authorUserId: 'u1' }), member: { load: async () => undefined, nameOf: () => name } })
    await settle(); expect(authorText(app)).toBe('Former member'); app.unmount()
  })
  test.each([null, undefined])('AC-4: rejected member roster with no cached name shows Member (%s)', async (name) => {
    const { app } = mountThread({ comment: comment({ authorUserId: 'u1' }), member: { load: async () => { throw new Error('offline') }, nameOf: () => name } })
    await settle(); expect(authorText(app)).toBe('Member'); app.unmount()
  })
  test('AC-5: shows agent name and badge when user author is null', async () => {
    const { app } = mountThread({ comment: comment({ authorUserId: null, authorAgentId: 'a1' }), agent: { load: async () => undefined, nameOf: () => 'mcp-probe' } })
    await settle()
    expect(authorText(app)).toBe('mcp-probe')
    const badge = app.one('[data-testid="comment-author-agent"]')
    expect(badge).toBeDefined()
    expect(badge ? app.textOf(badge) : '').toBe('Agent')
    app.unmount()
  })
  test.each([null, undefined])('AC-6: loaded agent roster without name shows removed agent (%s)', async (name) => {
    const { app } = mountThread({ comment: comment({ authorAgentId: 'a1' }), agent: { load: async () => undefined, nameOf: () => name } })
    await settle(); expect(authorText(app)).toBe('Removed agent'); app.unmount()
  })
  test.each([null, undefined])('AC-7: rejected agent roster with no name renders no author (%s)', async (name) => {
    const load = jest.fn(async () => { throw new Error('offline') })
    const { app } = mountThread({ comment: comment({ authorUserId: null, authorAgentId: 'a1' }), agent: { load, nameOf: () => name } })
    await settle(); expect(load).toHaveBeenCalledTimes(1); expect(app.find('[data-testid="comment-author"]')).toHaveLength(0); app.unmount()
  })
  test('AC-8: displays system author when neither id is set', async () => {
    const { app } = mountThread({ comment: comment({ authorUserId: null, authorAgentId: null }) })
    await settle(); expect(authorText(app)).toBe('System'); app.unmount()
  })
})

describe('CommentThread styled delete confirmation', () => {
  async function clickDelete(app: ReturnType<typeof mountThread>['app']) {
    const button = app.find('[data-stub="button"]').find(item => app.textOf(item) === 'Delete')
    expect(button).toBeDefined()
    await (button?.props.onClick as () => Promise<void>)()
    await settle()
  }
  test('AC-9: requests confirmation with the destructive dialog copy', async () => {
    const confirm = jest.fn(async () => false)
    const { app } = mountThread({ confirm })
    await clickDelete(app)
    expect(confirm).toHaveBeenCalledTimes(1)
    expect(confirm).toHaveBeenCalledWith({ title: 'Delete this comment?', body: "The comment is removed from the ticket's activity.", confirmLabel: 'Delete', destructive: true })
    app.unmount()
  })
  test('AC-10: cancel sends no request', async () => {
    const { app, api } = mountThread({ confirm: async () => false })
    await clickDelete(app)
    expect(api.delete).not.toHaveBeenCalled(); app.unmount()
  })
  test('AC-13: cancel shows neither error nor success toast', async () => {
    const { app, toast } = mountThread({ confirm: async () => false })
    await clickDelete(app)
    expect(toast.error).not.toHaveBeenCalled(); expect(toast.success).not.toHaveBeenCalled(); app.unmount()
  })
  test('AC-11: confirmation deletes the selected comment', async () => {
    const { app, api } = mountThread({ comment: comment({ id: 'c1' }), confirm: async () => true })
    await clickDelete(app)
    expect(api.delete).toHaveBeenCalledTimes(1); expect(api.delete).toHaveBeenCalledWith('/comments/c1'); app.unmount()
  })
  test('AC-12: confirmed delete failure reports the extracted API error', async () => {
    const failure = new Error('delete failed')
    const { app, toast } = mountThread({ confirm: async () => true, delete: async () => { throw failure } })
    await clickDelete(app)
    expect(toast.error).toHaveBeenCalledTimes(1); expect(toast.error).toHaveBeenCalledWith('delete failed'); app.unmount()
  })
})
