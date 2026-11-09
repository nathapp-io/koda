import { describe, expect, test } from '@jest/globals'
import * as Vue from 'vue'
import { mountSfc, webFile } from '../helpers/mount-sfc'
import { enI18n, toastRecorder } from '../helpers/fleet-harness'
import type { ThreadDetailDto } from '~/lib/thread-types'

const thread = (overrides: Partial<ThreadDetailDto> = {}): ThreadDetailDto => ({
  id: 't1', kind: 'REPO', repoId: 'r1', baseRef: 'main', feature: 'f-min', title: 'Thread', createdById: 'u1',
  runnerId: null, backend: { kind: 'native' }, status: 'ACTIVE', archivedAt: null, skills: [], maxCostUsd: '5',
  costUsd: '0', tokens: null, specPath: '.nax/features/f-min/spec.md', pendingQuestion: null, session: null,
  lastActivityAt: '', createdAt: '', activeJob: null, sendRefusal: null, writtenPaths: [], publishedSha: 'sha', specPublished: true,
  lastWrite: null, handoff: { plan: null, run: null }, preApproval: null, ...overrides,
})

async function mountCard(value: ThreadDetailDto, held = true) {
  const mounted = mountSfc(webFile('components', 'fleet', 'threads', 'ThreadPreApprovalCard.vue'), {
    props: { slug: 'web', thread: value },
    globals: { useI18n: () => enI18n(), useAppToast: () => toastRecorder(), useProjectPermissions: () => ({ permissions: { value: { has: () => held } } }) },
    alias: { '~/composables/useThreadPreApproval': { useThreadPreApproval: () => ({ set: async () => ({ kind: 'done' as const }), clear: async () => ({ kind: 'done' as const }) }) } },
    components: {
      Button: { template: '<button><slot /></button>' },
      Label: { template: '<label><slot /></label>' },
      Input: { template: '<input v-bind="$attrs" />' },
    },
  })
  await Vue.nextTick()
  return mounted
}

describe('ThreadPreApprovalCard', () => {
  test('AC-1, AC-2: displays Set and cap input on an authorized REPO thread without a tick', async () => {
    const mounted = await mountCard(thread())
    expect(mounted.text()).toContain('Set')
    expect(mounted.one('input')).not.toBeNull()
    mounted.unmount()
  })

  test('AC-3: renders nothing without the permission', async () => {
    const mounted = await mountCard(thread(), false)
    expect(mounted.text()).toBe('')
    mounted.unmount()
  })

  test('AC-4: renders nothing for an archived thread', async () => {
    const mounted = await mountCard(thread({ archivedAt: '2026-11-09T06:36:35.837Z' }))
    expect(mounted.text()).toBe('')
    mounted.unmount()
  })

  test('AC-5: renders nothing for a PROJECT thread', async () => {
    const mounted = await mountCard(thread({ kind: 'PROJECT' }))
    expect(mounted.text()).toBe('')
    mounted.unmount()
  })

  test('AC-6 to AC-9: displays exact cap and local set time with Clear, but no Set', async () => {
    const at = '2026-11-09T06:36:35.837Z'
    const mounted = await mountCard(thread({ preApproval: { userId: 'u1', at, costCapUsd: '3.0000' } }))
    expect(mounted.text()).toContain('$3.0000')
    expect(mounted.text()).toContain(new Date(at).toLocaleString())
    expect(mounted.text()).toContain('Clear')
    const button = mounted.one('button')
    expect(button).toBeDefined()
    expect(button ? mounted.textOf(button) : '').toBe('Clear')
    mounted.unmount()
  })
})
