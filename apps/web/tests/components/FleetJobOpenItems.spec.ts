import { describe, expect, jest, test } from '@jest/globals'
import { nextTick } from 'vue'
import { mountSfc, webFile, type FakeNode } from '../helpers/mount-sfc'
import { enI18n, toastRecorder, uiStubs } from '../helpers/fleet-harness'
import { projectPermissionsStub } from '../helpers/permission-nav'
import * as apiModule from '../../composables/useApi'
import type { FleetJobDto, FleetPrRulingDto } from '../../lib/fleet-types'

const job = {
  id: 'j1', command: 'RUN', repoId: 'r1', maxCostUsd: '5.0000', resultPrUrl: 'https://github.com/org/repo/pull/12',
  workflow: { outcome: 'draft', openItems: [
    { id: 'D-1', kind: 'decision', issue: '<script>unsafe</script>', file: 'src/a.ts', line: 7 },
    { id: 'B3', kind: 'finding', issue: 'missing check', file: 'src/b.ts', line: 20 },
  ] },
} as FleetJobDto
const ruling = (over: Partial<FleetPrRulingDto> = {}) => ({
  id: 'r1', itemId: 'D-1', disposition: 'waived', text: 'waive: out of scope', actorType: 'AGENT', actorId: 'agent-1', state: 'pending', skipReason: null,
  createdAt: '2026-11-04T02:00:00Z', ...over,
} as FleetPrRulingDto)
const settle = async () => { for (let i = 0; i < 8; i++) { await new Promise(resolve => setImmediate(resolve)); await nextTick() } }
const fire = (node: FakeNode, event: string, value?: unknown) => (node.props[event] as (v?: unknown) => unknown)(value)
function mount(permissions = ['fleet.job.rule', 'fleet.job.dispatch'], rows = [ruling()]) {
  const list = jest.fn(async () => rows)
  const create = jest.fn<(...args: unknown[]) => Promise<unknown>>(async () => ruling())
  const dispatch = jest.fn(async () => ({ job: { id: 'fix1' } }))
  const navigate = jest.fn()
  const toast = toastRecorder()
  const app = mountSfc(webFile('components/fleet/FleetJobOpenItems.vue'), {
    props: { slug: 'koda', job },
    components: { ...uiStubs, Select: uiStubs.Input, SelectTrigger: uiStubs.Input, SelectValue: uiStubs.Input, SelectContent: uiStubs.Input, SelectItem: uiStubs.Input },
    alias: {
      '~/composables/useApi': apiModule,
      '~/composables/useFleetRulings': { useFleetRulings: () => ({ list, create }) },
    },
    globals: { useI18n: () => enI18n(), useAppToast: () => toast,
      useProjectPermissions: () => projectPermissionsStub(permissions),
      useFleetJobs: () => ({ dispatch }), navigateTo: navigate,
    },
  })
  return { app, list, create, dispatch, navigate, toast,
    byId: (id: string) => {
      const node = app.one(`[data-testid="${id}"]`)
      if (!node) throw new Error(`Missing control ${id}`)
      return node
    } }
}
async function fill(m: ReturnType<typeof mount>, keyword: string, reason: string) {
  fire(m.byId('ruling-keyword-D-1'), 'onUpdate:modelValue', keyword)
  fire(m.byId('ruling-reason-D-1'), 'onUpdate:modelValue', reason)
  await settle()
  await fire(m.byId('ruling-form-D-1'), 'onSubmit', { preventDefault() {}, stopPropagation() {} })
  await settle()
}

describe('draft RUN open items', () => {
  test('AC-3: renders two safe rows with id, kind, issue and file:line', async () => {
    const m = mount(); await settle()
    expect(m.app.find('[data-testid="open-item"]')).toHaveLength(2)
    expect(m.app.text()).toContain('D-1 decision <script>unsafe</script> src/a.ts:7')
    expect(m.app.text()).toContain('B3 finding missing check src/b.ts:20')
    expect(m.app.find('script')).toHaveLength(0)
    m.app.unmount()
  })
  test('AC-4: uses the latest ruling per item, showing disposition, ruler and pending state', async () => {
    const m = mount(undefined, [ruling(), ruling({ id: 'old', disposition: 'confirmed', state: 'replaced', createdAt: '2026-11-03T00:00:00Z' })]); await settle()
    expect(m.app.text()).toContain('Waived')
    expect(m.app.text()).toContain('agent-1')
    expect(m.app.text()).toContain('Pending')
    expect(m.app.text()).not.toContain('Confirmed')
    m.app.unmount()
  })
  test('AC-5: renders translated skipped reason', async () => {
    const m = mount(undefined, [ruling({ state: 'skipped', skipReason: 'superseded-by-writer' })]); await settle()
    expect(m.app.text()).toContain('Superseded by a repository writer')
    m.app.unmount()
  })
  test('AC-6: waive form creates the keyword line and reloads rulings', async () => {
    const m = mount(); await settle(); await fill(m, 'waive', 'out of scope')
    expect(m.create).toHaveBeenCalledWith('j1', { itemId: 'D-1', text: 'waive: out of scope' })
    expect(m.list).toHaveBeenCalledTimes(2)
    m.app.unmount()
  })
  test('form allows the API limit of 2000 characters and rejects 2001', async () => {
    const m = mount(); await settle(); await fill(m, 'waive', 'x'.repeat(1993))
    expect(m.create).toHaveBeenCalledWith('j1', { itemId: 'D-1', text: `waive: ${'x'.repeat(1993)}` })
    m.create.mockClear()
    await fill(m, 'waive', 'x'.repeat(1994))
    expect(m.create).not.toHaveBeenCalled()
    expect(m.app.text()).toContain('Ruling must be at most 2000 characters')
    m.app.unmount()
  })
  test('AC-7: confirm without evidence validates before API', async () => {
    const m = mount(); await settle(); await fill(m, 'confirm', '')
    expect(m.create).not.toHaveBeenCalled()
    expect(m.app.text()).toContain('Evidence or a reason is required')
    m.app.unmount()
  })
  test('AC-8: no ruling forms without permission', async () => {
    const m = mount(['fleet.job.dispatch']); await settle()
    expect(m.app.find('form')).toHaveLength(0)
    m.app.unmount()
  })
  test('AC-9: unwrapped 202 approval summary produces pending toast, not recorded success', async () => {
    const m = mount(); m.create.mockResolvedValue({ id: 'approval1', permissionKey: 'fleet.job.rule', status: 'pending' })
    await settle(); await fill(m, 'waive', 'out of scope')
    expect(m.toast.calls).toEqual([{ kind: 'success', message: 'Ruling pending approval' }])
    expect(m.list).toHaveBeenCalledTimes(1)
    m.app.unmount()
  })
  test('AC-10: 409 uses extractApiError on response', async () => {
    const m = mount(); const error = { status: 409, data: { ret: 409, message: 'This item is settled' } }
    m.create.mockRejectedValue(error)
    await settle(); await fill(m, 'waive', 'out of scope')
    expect(m.toast.calls).toEqual([{ kind: 'error', message: apiModule.extractApiError(error) }])
    m.app.unmount()
  })
  test('AC-11: Finish dispatches FIX with repo, PR and numeric configured cap, then opens job', async () => {
    const m = mount(); await settle(); await fire(m.byId('fleet-job-finish'), 'onClick'); await settle()
    expect(m.dispatch).toHaveBeenCalledWith({ command: 'FIX', repoId: 'r1', prNumber: 12, maxCostUsd: 5 })
    expect(m.navigate).toHaveBeenCalledWith('/koda/fleet/jobs/fix1')
    m.app.unmount()
  })
  test('AC-12: Finish is hidden without dispatch permission', async () => {
    const m = mount(['fleet.job.rule']); await settle()
    expect(m.app.find('[data-testid="fleet-job-finish"]')).toHaveLength(0)
    m.app.unmount()
  })
  test('list failure shows retry and no editable forms; retry restores forms', async () => {
    const m = mount(); await settle()
    m.list.mockRejectedValueOnce({ data: { message: 'Rulings unavailable' } })
    m.app.setProps({ job: { ...job } }); await settle()
    expect(m.app.find('form')).toHaveLength(0)
    const retry = m.app.one('[data-stub="error-state"]')
    expect(retry).toBeDefined()
    expect(m.toast.calls).toContainEqual({ kind: 'error', message: 'Rulings unavailable' })
    if (retry) await fire(retry, 'onRetry')
    await settle()
    expect(m.app.find('form')).toHaveLength(2)
    m.app.unmount()
  })
  test('applied items are read-only and unknown skip reasons remain safe text', async () => {
    const m = mount(undefined, [ruling({ state: 'applied' }), ruling({ itemId: 'B3', state: 'skipped', skipReason: '<img src=x>' })]); await settle()
    expect(m.app.find('form')).toHaveLength(1)
    expect(m.app.text()).toContain('Applied')
    expect(m.app.text()).toContain('<img src=x>')
    expect(m.app.find('img')).toHaveLength(0)
    m.app.unmount()
  })
  test('Finish API refusal surfaces its response and restores the button', async () => {
    const m = mount(); await settle()
    m.dispatch.mockRejectedValueOnce({ data: { message: 'PR has another active job' } })
    await fire(m.byId('fleet-job-finish'), 'onClick'); await settle()
    expect(m.toast.calls).toContainEqual({ kind: 'error', message: 'PR has another active job' })
    expect(m.byId('fleet-job-finish').props.disabled).toBe(false)
    expect(m.navigate).not.toHaveBeenCalled()
    m.app.unmount()
  })
  test('fixed and verify send grammar lines without a client parser', async () => {
    const m = mount(); await settle()
    await fill(m, 'fixed', '4f2e1aa — null check added')
    expect(m.create).toHaveBeenLastCalledWith('j1', { itemId: 'D-1', text: 'fixed 4f2e1aa — null check added' })
    await fill(m, 'verify', '')
    expect(m.create).toHaveBeenLastCalledWith('j1', { itemId: 'D-1', text: 'verify' })
    m.app.unmount()
  })
  test('Finish remains available for a draft RUN after PR readiness; GitLab has no Finish', async () => {
    const m = mount(); await settle()
    m.app.setProps({ job: { ...job, fixReady: { markedReady: true } } }); await settle()
    expect(m.app.find('[data-testid="fleet-job-finish"]')).toHaveLength(1)
    m.app.setProps({ job: { ...job, resultPrUrl: 'https://gitlab.com/org/repo/-/merge_requests/12' } }); await settle()
    expect(m.app.find('[data-testid="fleet-job-finish"]')).toHaveLength(0)
    expect(m.app.find('form')).toHaveLength(0)
    m.app.unmount()
  })
})
