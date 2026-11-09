import { describe, expect, jest, test } from '@jest/globals'
import * as Vue from 'vue'
import { mountSfc, webFile } from '../helpers/mount-sfc'
import { enI18n, toastRecorder } from '../helpers/fleet-harness'
import type { ThreadDetailDto } from '~/lib/thread-types'
import { extractApiError } from '~/composables/useApi'

const thread: ThreadDetailDto = {
  id: 't1', kind: 'REPO', repoId: 'r1', baseRef: 'main', feature: 'f-min', title: 'Thread', createdById: 'u1',
  runnerId: null, backend: { kind: 'native' }, status: 'ACTIVE', archivedAt: null, skills: [], maxCostUsd: '5',
  costUsd: '0', tokens: null, specPath: '.nax/features/f-min/spec.md', pendingQuestion: null, session: null,
  lastActivityAt: '', createdAt: '', activeJob: null, sendRefusal: null, writtenPaths: [], publishedSha: 'sha',
  specPublished: true, lastWrite: null, handoff: { plan: null, run: null }, preApproval: null,
}

function mountCard(set: jest.Mock, clear: jest.Mock, value: ThreadDetailDto = thread) {
  const toast = toastRecorder()
  const changed = jest.fn()
  const app = mountSfc(webFile('components', 'fleet', 'threads', 'ThreadPreApprovalCard.vue'), {
    props: { slug: 'web', thread: value, onChanged: changed },
    globals: {
      useI18n: () => enI18n(), useAppToast: () => toast,
      useProjectPermissions: () => ({ permissions: { value: { has: () => true } } }),
    },
    alias: {
      '~/composables/useThreadPreApproval': { useThreadPreApproval: (slug: string) => {
        expect(slug).toBe('web')
        return { set, clear }
      } },
      '~/composables/useApi': { extractApiError },
    },
    components: {
      Button: { template: '<button v-bind="$attrs"><slot /></button>' },
      Label: { template: '<label><slot /></label>' },
      Input: { template: '<input v-bind="$attrs" />' },
    },
  })
  return { app, toast, changed }
}

async function settle() { await Vue.nextTick(); await Promise.resolve(); await Vue.nextTick() }
function click(app: ReturnType<typeof mountSfc>, selector: string) {
  const button = app.one(selector)
  if (button?.props.onClick) (button.props.onClick as () => void)()
}

describe('US-011: pre-approval card actions', () => {
  test('AC-1, AC-2: invalid cap shows translated validation and does not write', async () => {
    const set = jest.fn(async () => ({ kind: 'done' as const }))
    const mounted = mountCard(set, jest.fn())
    const input = mounted.app.one('[data-testid="preapproval-cap-input"]')
    if (input?.props['onUpdate:modelValue']) (input.props['onUpdate:modelValue'] as (value: number) => void)(0)
    click(mounted.app, '[data-testid="preapproval-set"]')
    await settle()
    expect(mounted.app.text()).toContain(enI18n().t('fleet.flows.preapproval.validation'))
    expect(set).not.toHaveBeenCalled()
    mounted.app.unmount()
  })

  test('AC-3, AC-4: valid Set calls composable and done emits changed', async () => {
    const set = jest.fn(async () => ({ kind: 'done' as const }))
    const mounted = mountCard(set, jest.fn())
    const input = mounted.app.one('[data-testid="preapproval-cap-input"]')
    if (input?.props['onUpdate:modelValue']) (input.props['onUpdate:modelValue'] as (value: number) => void)(3)
    click(mounted.app, '[data-testid="preapproval-set"]')
    await settle()
    expect(set).toHaveBeenCalledTimes(1)
    expect(set).toHaveBeenCalledWith('t1', 3)
    expect(mounted.changed).toHaveBeenCalledTimes(1)
    mounted.app.unmount()
  })

  test('AC-5, AC-6: Clear calls composable and done emits changed', async () => {
    const clear = jest.fn(async () => ({ kind: 'done' as const }))
    const mounted = mountCard(jest.fn(), clear, { ...thread, preApproval: { userId: 'u1', at: '2026-11-09T06:36:35.837Z', costCapUsd: '3.0000' } })
    click(mounted.app, '[data-testid="preapproval-clear"]')
    await settle()
    expect(clear).toHaveBeenCalledTimes(1)
    expect(clear).toHaveBeenCalledWith('t1')
    expect(mounted.changed).toHaveBeenCalledTimes(1)
    mounted.app.unmount()
  })

  test('AC-7, AC-8: pending Set toasts approval request without changed', async () => {
    const set = jest.fn(async () => ({ kind: 'pending' as const, request: {} as never }))
    const mounted = mountCard(set, jest.fn())
    const input = mounted.app.one('[data-testid="preapproval-cap-input"]')
    if (input?.props['onUpdate:modelValue']) (input.props['onUpdate:modelValue'] as (value: number) => void)(3)
    click(mounted.app, '[data-testid="preapproval-set"]')
    await settle()
    expect(mounted.toast.successes).toEqual([enI18n().t('fleet.flows.toast.approvalRequested')])
    expect(mounted.changed).not.toHaveBeenCalled()
    mounted.app.unmount()
  })

  test('AC-9, AC-10: rejected Clear toasts extracted API error without changed', async () => {
    const error = new Error('write denied')
    const clear = jest.fn(async () => { throw error })
    const mounted = mountCard(jest.fn(), clear, { ...thread, preApproval: { userId: 'u1', at: '2026-11-09T06:36:35.837Z', costCapUsd: '3.0000' } })
    click(mounted.app, '[data-testid="preapproval-clear"]')
    await settle()
    expect(mounted.toast.errors).toEqual([extractApiError(error)])
    expect(mounted.changed).not.toHaveBeenCalled()
    mounted.app.unmount()
  })

  test('AC-11: second Set click is ignored while the write is pending', async () => {
    let resolve!: (value: { kind: 'done' }) => void
    const set = jest.fn(() => new Promise<{ kind: 'done' }>((done) => { resolve = done }))
    const mounted = mountCard(set, jest.fn())
    const input = mounted.app.one('[data-testid="preapproval-cap-input"]')
    if (input?.props['onUpdate:modelValue']) (input.props['onUpdate:modelValue'] as (value: number) => void)(3)
    click(mounted.app, '[data-testid="preapproval-set"]')
    click(mounted.app, '[data-testid="preapproval-set"]')
    expect(set).toHaveBeenCalledTimes(1)
    resolve({ kind: 'done' })
    await settle()
    mounted.app.unmount()
  })

  test('AC-15: pending Clear does not emit changed', async () => {
    const clear = jest.fn(async () => ({ kind: 'pending' as const, request: {} as never }))
    const mounted = mountCard(jest.fn(), clear, { ...thread, preApproval: { userId: 'u1', at: '2026-11-09T06:36:35.837Z', costCapUsd: '3.0000' } })
    click(mounted.app, '[data-testid="preapproval-clear"]')
    await settle()
    expect(mounted.changed).not.toHaveBeenCalled()
    mounted.app.unmount()
  })
})
