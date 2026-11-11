import { describe, test, expect, jest } from '@jest/globals'
import { ref } from 'vue'
import { mountSfc, webFile, loadSfc } from '../helpers/mount-sfc'
import type { Mounted } from '../helpers/mount-sfc'
import { uiStubs, enI18n, toastRecorder } from '../helpers/fleet-harness'
import * as apiModule from '../../composables/useApi'
import { ApiError } from '../../composables/useApi'

const page = webFile('pages', '[project]', 'memory.vue')
const item = (kind: string) => ({ id: kind === 'NOTE' ? 'n1' : 'm1', subject: 'subject', predicate: 'predicate', object: 'body', kind, confidence: 1, status: 'active', description: 'description', scope: 'project' })
const flush = async () => { for (let i = 0; i < 6; i++) { await new Promise(resolve => setImmediate(resolve)); await new Promise(resolve => setTimeout(resolve, 0)); await Promise.resolve() } }
async function submit(app: Mounted): Promise<void> {
  await (app.one('form')?.props.onSubmit as (event: { preventDefault: () => void }) => Promise<void>)({ preventDefault: () => undefined })
}

function setup(kind: string, post: jest.Mock, lookup = jest.fn(async () => 'project-id'), apply = jest.fn(async () => undefined)) {
  const memory = { items: ref([item(kind)]), isLoading: ref(false), error: ref(null), hasMore: ref(false), kindFilter: ref(''), statusFilter: ref(''), textFilter: ref(''), loadMemory: jest.fn(), applyFilters: apply, loadMore: jest.fn(), retireDecision: jest.fn(async (id: string, reason?: string) => post(`/memory/${id}/retire`, reason ? { reason } : {}).then((v: unknown) => v)), retireNote: jest.fn(async (id: string, projectId: string, reason?: string) => post(`/memory/notes/${id}/retire`, { projectId, ...(reason ? { reason } : {}) }).then((v: unknown) => v)) }
  const api = { get: jest.fn(), post: jest.fn() }
  const toasts = toastRecorder()
  const app = mountSfc(page, {
    components: { ...uiStubs, PageHeader: uiStubs.PageHeader, FilterBar: { template: '<div><slot /></div>' }, LoadingState: uiStubs.LoadingState, FormField: loadSfc(webFile('components', 'ui', 'form', 'FormField.vue')), FormMessage: loadSfc(webFile('components', 'ui', 'form', 'FormMessage.vue')), MemoryRetireDialog: loadSfc(webFile('components', 'memory', 'MemoryRetireDialog.vue'), { useI18n: () => enI18n() }) },
    alias: { '~/composables/useMemory': { useMemory: () => memory, watchDebouncedMemorySearch: () => undefined }, '~/composables/useProjectRef': { useProjectRef: () => ({ load: lookup }) }, '~/composables/useApi': apiModule },
    globals: { useRoute: () => ({ params: { project: 'sb' } }), useI18n: () => enI18n(), useAppToast: () => toasts, useProjectPermissions: () => ({ permissions: ref({ has: () => true, hasOwn: () => false }) }), useMemory: () => memory },
  })
  return { app, memory, api, toasts, lookup, flush }
}

describe('US-004 Memory retire flow', () => {
  test('DECISION action submits the reason to retireDecision', async () => {
    const post = jest.fn(async () => ({})); const x = setup('DECISION', post); await flush()
    x.app.find('button').find(b => x.app.textOf(b) === 'memory.retire.action')?.props.onClick?.()
    await flush()
    expect(x.app.one('form')).toBeDefined()
    const field = x.app.find('[data-testid="memory-retire-reason"]')[0]
    expect(field).toBeDefined()
    ;(field?.props['onUpdate:modelValue'] as (v: string) => void)('obsolete')
    await submit(x.app); await flush()
    expect(post).toHaveBeenCalledWith('/memory/m1/retire', { reason: 'obsolete' })
    expect(x.toasts.successes).toEqual(['memory.retire.done'])
    x.app.unmount()
  })

  test('NOTE resolves project id before retiring; lookup failure toasts and skips POST', async () => {
    const post = jest.fn(async () => ({})); const lookup = jest.fn(async () => { throw new ApiError(404, 'Project missing') }); const x = setup('NOTE', post, lookup); await flush()
    x.app.find('button').find(b => x.app.textOf(b) === 'memory.retire.action')?.props.onClick?.(); await flush()
    await submit(x.app); await flush()
    expect(lookup).toHaveBeenCalled(); expect(post).not.toHaveBeenCalled(); expect(x.toasts.errors).toEqual(['Project missing'])
    x.app.unmount()
  })

  test('pending outcome closes the dialog without refreshing', async () => {
    const post = jest.fn(async () => ({ permissionKey: 'memory.decision.retire' })); const apply = jest.fn(async () => undefined); const x = setup('DECISION', post, undefined, apply); await flush()
    x.app.find('button').find(b => x.app.textOf(b) === 'memory.retire.action')?.props.onClick?.(); await flush()
    await submit(x.app); await flush()
    expect(x.toasts.successes).toEqual(['memory.retire.pending']); expect(apply).not.toHaveBeenCalled(); expect(x.app.find('button').some(b => x.app.textOf(b) === 'memory.retire.confirm')).toBe(false)
    x.app.unmount()
  })

  test('retire rejection preserves dialog and does not refresh', async () => {
    const post = jest.fn(async () => { throw new ApiError(409, 'Decision is not active') }); const apply = jest.fn(async () => undefined); const x = setup('DECISION', post, undefined, apply); await flush()
    x.app.find('button').find(b => x.app.textOf(b) === 'memory.retire.action')?.props.onClick?.(); await flush()
    await submit(x.app); await flush()
    expect(x.toasts.errors).toEqual(['Decision is not active']); expect(apply).not.toHaveBeenCalled(); expect(x.app.find('button').some(b => x.app.textOf(b) === 'memory.retire.confirm')).toBe(true)
    x.app.unmount()
  })
})
