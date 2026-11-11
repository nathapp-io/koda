import { describe, expect, test } from '@jest/globals'
import { nextTick, ref } from 'vue'
import { mountSfc, webFile } from '../helpers/mount-sfc'
import { projectPermissionsStub } from '../helpers/permission-nav'

const page = webFile('pages', '[project]', 'memory.vue')
const rows = (kind: string, status = 'active') => [{ id: 'n1', subject: 'subject', predicate: 'predicate', object: 'PRIVATE_NOTE_BODY', kind, confidence: 1, status, description: 'note description', scope: 'project' }]

function mountMemory(items: ReturnType<typeof rows>, keys: string[] = []) {
  const memory = {
    items: ref(items), isLoading: ref(false), error: ref(null), hasMore: ref(false),
    kindFilter: ref(''), statusFilter: ref(''), textFilter: ref(''),
    loadMemory: async () => undefined, applyFilters: async () => undefined, loadMore: async () => undefined,
  }
  return mountSfc(page, {
    globals: {
      useRoute: () => ({ params: { project: 'sb' } }),
      useI18n: () => ({ t: (key: string) => key }),
      useAppToast: () => ({ error: () => undefined }),
      useProjectPermissions: () => projectPermissionsStub(keys),
      useMemory: () => memory,
    },
    alias: {
      '~/composables/useMemory': { useMemory: () => memory, watchDebouncedMemorySearch: () => undefined },
      '~/composables/useApi': { extractApiError: (error: unknown) => String(error) },
      '~/composables/usePermissions': { useProjectPermissions: () => projectPermissionsStub(keys) },
    },
    components: { PageHeader: { template: '<div><slot name="icon"/><slot/></div>' }, FilterBar: { template: '<div><slot/></div>' }, LoadingState: { template: '<div />' }, Button: { template: '<button><slot/></button>' } },
  })
}

const actionButtons = (mounted: ReturnType<typeof mountMemory>) => mounted.find('button').filter(button => mounted.textOf(button) === 'memory.retire.action')

describe('US-003 Memory Retire visibility', () => {
  test('AC-1 active DECISION with retire permission renders action in its row', () => {
    const mounted = mountMemory(rows('DECISION'), ['memory.decision.retire'])
    const row = mounted.find('tr').at(-1)
    expect(row).toBeDefined()
    expect(actionButtons(mounted)).toHaveLength(1)
    expect(row ? mounted.find('button', row).length : 0).toBeGreaterThan(0)
  })

  test('AC-2 DECISION without retire permission has no action', () => {
    expect(actionButtons(mountMemory(rows('DECISION')))).toHaveLength(0)
  })

  test('AC-3 own-only NOTE creation permission renders action', () => {
    const mounted = mountMemory(rows('NOTE'), ['memory.create.own'])
    expect(actionButtons(mounted)).toHaveLength(1)
  })

  test('AC-4 FACT has no action even when every memory permission is granted', () => {
    expect(actionButtons(mountMemory(rows('FACT'), ['memory.decision.retire', 'memory.create', 'memory.update']))).toHaveLength(0)
  })

  test('AC-5 superseded DECISION has no action despite permission', () => {
    expect(actionButtons(mountMemory(rows('DECISION', 'superseded'), ['memory.decision.retire', 'memory.create', 'memory.update']))).toHaveLength(0)
  })

  test('AC-6 NOTE body remains hidden until expanded', async () => {
    const mounted = mountMemory(rows('NOTE'))
    expect(mounted.text()).not.toContain('PRIVATE_NOTE_BODY')
    const expand = mounted.find('button').find(button => mounted.textOf(button) === 'memory.expand')
    expect(expand).toBeDefined()
    ;(expand?.props.onClick as (() => void))()
    await nextTick()
    expect(mounted.text()).toContain('PRIVATE_NOTE_BODY')
  })
})
