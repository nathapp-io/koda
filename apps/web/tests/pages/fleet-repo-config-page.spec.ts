import { describe, expect, jest, test } from '@jest/globals'
import * as Vue from 'vue'
import * as protocol from '@nathapp/fleet-protocol'
import { mountSfc, webFile } from '../helpers/mount-sfc'
import type { FakeNode } from '../helpers/mount-sfc'
import { enI18n, toastRecorder, uiStubs } from '../helpers/fleet-harness'
import * as apiModule from '../../composables/useApi'
import { ApiError } from '../../composables/useApi'

const page = webFile('pages', '[project]', 'fleet', 'repos', '[id]', 'config.vue')
// `__esModule` is required (same as fleet-config-tree-editor.spec.ts): NaxFileEditor default-imports
// this module, and without the marker the harness's `__importDefault` wraps the wrapper, so Vue
// received `{ default: … }` as the component and rendered nothing.
const mdStub = { __esModule: true as const, default: { name: 'Md', props: ['modelValue'], emits: ['update:modelValue'], template: '<textarea data-testid="md-editor" :value="modelValue" @input="$emit(\'update:modelValue\', $event.target.value)" />' } }

const LIST = {
  baseSha: 'head1',
  defaultBranch: 'main',
  files: [
    { path: '.nax/context.md', size: 5, blobSha: 'ctx1', group: 'context' },
    { path: '.nax/config.json', size: 2, blobSha: 'cfg1', group: 'config' },
  ],
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 6; i += 1) {
    await new Promise((resolve) => { setImmediate(resolve) })
    await Vue.nextTick()
  }
}
const click = (n: FakeNode | undefined): unknown => (n?.props.onClick as () => unknown)()

function harness(opts: { role?: { canManage: boolean; viewerRole: string | null }; query?: Record<string, string>; api?: Record<string, jest.Mock> } = {}) {
  const api = {
    list: jest.fn(async () => LIST),
    read: jest.fn(async (_repo: string, path: string) => ({ path, blobSha: path === '.nax/context.md' ? 'ctx1' : 'cfg1', content: path.endsWith('.json') ? '{}' : 'hello' })),
    submitEdit: jest.fn(async () => ({ job: { id: 'job-new' }, placement: { assigned: false, runnerId: null, misfits: [] } })),
    submitRegenerate: jest.fn(),
    submitDrift: jest.fn(async () => ({ job: { id: 'job-drift' }, placement: { assigned: false, runnerId: null, misfits: [] } })),
    jobEdits: jest.fn(),
    activeConfigJob: jest.fn(async () => null),
    ...(opts.api ?? {}),
  }
  const navigateTo = jest.fn(async () => undefined)
  const toasts = toastRecorder()
  const app = mountSfc(page, {
    components: uiStubs,
    alias: { '@nathapp/fleet-protocol': protocol, '~/composables/useApi': apiModule, '~/components/MarkdownEditor.vue': mdStub },
    globals: {
      definePageMeta: () => undefined,
      useRoute: () => ({ params: { project: 'p', id: 'r1' }, query: opts.query ?? {} }),
      useI18n: () => enI18n(),
      useAppToast: () => toasts,
      useFleetRepoConfig: () => api,
      useFleetDispatchOptions: () => ({ load: async () => undefined, repoName: () => 'acme/app' }),
      useProjectViewerRole: () => ({ data: Vue.ref(opts.role ?? { canManage: false, viewerRole: 'DEVELOPER' }) }),
      navigateTo,
      onBeforeRouteLeave: () => undefined,
    },
  })
  return { app, api, navigateTo, toasts }
}

describe('config page (S3 §6)', () => {
  test('loads the list, reads a file at baseSha on select, edits, and submits the edit set', async () => {
    const { app, api, navigateTo } = harness()
    await flush()
    expect(api.list).toHaveBeenCalledWith('r1')
    click(app.find('[data-testid="nax-file"]').find((n) => n.props['data-path'] === '.nax/context.md'))
    await flush()
    expect(api.read).toHaveBeenCalledWith('r1', '.nax/context.md', 'head1')
    expect(app.one('[data-testid="config-save"]')?.props.disabled).toBe(true)
    ;(app.one('[data-testid="md-editor"]')?.props.onInput as (e: unknown) => void)({ target: { value: 'changed' } })
    await flush()
    expect(app.find('[data-testid="nax-file"]').find((n) => n.props['data-path'] === '.nax/context.md')?.props['data-status']).toBe('modified')
    expect(app.one('[data-testid="config-save"]')?.props.disabled).toBe(false)
    click(app.one('[data-testid="config-save"]'))
    await flush()
    ;(app.find('[data-testid="config-pr-title"]')[0].props['onUpdate:modelValue'] as (v: string) => void)('Edit context')
    await flush()
    click(app.one('[data-testid="config-pr-submit"]'))
    await flush()
    expect(api.submitEdit).toHaveBeenCalledWith('r1', {
      baseSha: 'head1', edits: [{ path: '.nax/context.md', op: 'put', content: 'changed', baseSha: 'ctx1' }], prTitle: 'Edit context', prBody: '',
    })
    expect(navigateTo).toHaveBeenCalledWith('/p/fleet/jobs/job-new')
  })

  test('invalid JSON blocks save and is listed as a problem', async () => {
    const { app } = harness()
    await flush()
    click(app.find('[data-testid="nax-file"]').find((n) => n.props['data-path'] === '.nax/config.json'))
    await flush()
    ;(app.one('[data-testid="nax-editor-json"]')?.props.onInput as (e: unknown) => void)({ target: { value: '{bad' } })
    await flush()
    expect(app.one('[data-testid="config-save"]')?.props.disabled).toBe(true)
    expect(app.find('[data-testid="config-problem"]')).toHaveLength(1)
  })

  test('a VIEWER gets a read-only page: notice, no save/new/delete/drift, read-only editor', async () => {
    const { app } = harness({ role: { canManage: false, viewerRole: 'VIEWER' } })
    await flush()
    click(app.find('[data-testid="nax-file"]')[0])
    await flush()
    expect(app.one('[data-testid="config-readonly-notice"]')).toBeDefined()
    for (const id of ['config-save', 'config-new-file', 'config-delete-file', 'config-drift']) {
      expect(app.one(`[data-testid="${id}"]`)).toBeUndefined()
    }
    expect(app.one('[data-testid="nax-editor-readonly"]')).toBeDefined()
  })

  test('a 409 on drift check links the active config job', async () => {
    const { app } = harness({
      api: {
        submitDrift: jest.fn(async () => { throw new ApiError(409, 'A config job is already active: j-live') }),
        activeConfigJob: jest.fn(async () => ({ id: 'j-live', state: 'RUNNING' })),
      },
    })
    await flush()
    click(app.one('[data-testid="config-drift"]'))
    await flush()
    expect(app.one('[data-testid="config-active-job-link"]')?.props.to).toBe('/p/fleet/jobs/j-live')
  })

  test('a 409 on the list (repo unreachable) shows the message instead of the editor', async () => {
    const { app } = harness({ api: { list: jest.fn(async () => { throw new ApiError(409, 'repo_unreachable') }) } })
    await flush()
    expect(app.textOf(app.one('[data-testid="config-unreachable"]') as FakeNode)).toContain('repo_unreachable')
    expect(app.find('[data-testid="nax-file"]')).toHaveLength(0)
  })

  test('a 422 on read marks the file too large and read-only', async () => {
    const { app } = harness({ api: { read: jest.fn(async () => { throw new ApiError(422, 'too large') }) } })
    await flush()
    click(app.find('[data-testid="nax-file"]')[0])
    await flush()
    expect(app.one('[data-testid="nax-editor-too-large"]')).toBeDefined()
  })

  test('?reopen= re-applies the stored edits on the latest files; a conflict blocks save until resolved', async () => {
    const { app, api } = harness({
      query: { reopen: 'job-failed' },
      api: {
        jobEdits: jest.fn(async () => ({ mode: 'edit', baseSha: 'old', prTitle: 'T', prBody: null, edits: [{ path: '.nax/context.md', op: 'put', content: 'mine', baseSha: 'ctx0' }] })),
      },
    })
    await flush()
    expect(api.jobEdits).toHaveBeenCalledWith('job-failed')
    expect(app.find('[data-testid="nax-change-conflict"]')).toHaveLength(1)
    expect(app.one('[data-testid="config-save"]')?.props.disabled).toBe(true)
    click(app.one('[data-testid="nax-change-resolve"]'))
    await flush()
    expect(app.one('[data-testid="config-save"]')?.props.disabled).toBe(false)
  })
})
