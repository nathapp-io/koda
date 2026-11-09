import { describe, expect, jest, test } from '@jest/globals'
import * as Vue from 'vue'
import { ref } from 'vue'
import { mountSfc, webFile } from '../helpers/mount-sfc'
import { enI18n, toastRecorder } from '../helpers/fleet-harness'
import type { ThreadDetailDto } from '~/lib/thread-types'
import type { FlowStartBody } from '~/lib/fleet-flow-start-body'
import { projectPermissionsStub } from '../helpers/permission-nav'
import { ApiError, extractApiError } from '../../composables/useApi'

const thread: ThreadDetailDto = {
  id: 't1', kind: 'REPO', repoId: 'r1', baseRef: 'main', feature: 'f-min', title: 'Thread', createdById: 'u1',
  runnerId: null, backend: { kind: 'native' }, status: 'ACTIVE', archivedAt: null, skills: [], maxCostUsd: '5',
  costUsd: '0', tokens: null, specPath: '.nax/features/f-min/spec.md', pendingQuestion: null, session: null,
  lastActivityAt: '', createdAt: '', activeJob: null, sendRefusal: null, writtenPaths: [], publishedSha: 'sha',
  specPublished: true, lastWrite: null, handoff: { plan: null, run: null }, preApproval: null,
}
const body: FlowStartBody = { features: [], roles: { reviewer: 'm', supervisor: 'm' }, costCapUsd: 5 }
const startFile = webFile('components', 'fleet', 'threads', 'ThreadStartFlow.vue')

async function mountStart(result: Promise<unknown> = Promise.resolve({ kind: 'pending' }), viewer: { id: string } | null = { id: 'u1' }) {
  let dialogProps: Record<string, unknown> | undefined
  let emitSubmit: ((body: FlowStartBody) => void) | undefined
  const dialogStub = Vue.defineComponent({
    props: ['open', 'thread', 'viewerId'], emits: ['update:open', 'submit'],
    setup(props, { emit }) {
      Vue.watchEffect(() => { dialogProps = { ...props } })
      emitSubmit = value => emit('submit', value)
      return () => Vue.h('div', { 'data-testid': 'start-dialog', 'data-open': String(props.open) })
    },
  })
  const createFromThread = jest.fn((_threadId: string, _body: FlowStartBody) => result)
  const toast = toastRecorder()
  const navigateTo = jest.fn()
  const auth = { user: ref(viewer) }
  const mounted = mountSfc(startFile, {
    props: { slug: 'web', thread },
    components: { NuxtLink: { props: ['to'], template: '<a :href="to"><slot /></a>' }, ThreadStartFlowDialog: dialogStub, FleetThreadsThreadStartFlowDialog: dialogStub, Button: Vue.defineComponent({ emits: ['click'], setup(_props, { attrs, slots, emit }) { return () => Vue.h('button', { ...attrs, onClick: () => emit('click') }, slots.default?.()) } }) },
    globals: { useAuth: () => auth, useAppToast: () => toast, useI18n: () => enI18n(), useProjectPermissions: () => projectPermissionsStub(['fleet.flow.create', 'fleet.flow.read']), navigateTo },
    alias: {
      '~/composables/useAuth': { useAuth: () => auth },
      '~/composables/useAppToast': { useAppToast: () => toast },
      '~/composables/useFleetFlows': { useFleetFlows: () => ({ list: async () => ({ records: [] }), createFromThread }) },
      '~/composables/useApi': { extractApiError },
    },
  })
  const button = mounted.one('[data-testid="start-flow-button"]')
  if (button?.props.onClick) (button.props.onClick as () => void)()
  await Vue.nextTick()
  return { mounted, createFromThread, toast, navigateTo, get dialogProps() { return dialogProps }, submit: (value = body) => emitSubmit?.(value) }
}
const settle = async () => { for (let i = 0; i < 5; i++) { await Promise.resolve(); await Vue.nextTick(); await new Promise(resolve => setImmediate(resolve)) } }

describe('US-009 ThreadStartFlow submit', () => {
  test('AC-1..4 opens dialog with thread and nullable viewer id', async () => {
    const signedIn = await mountStart()
    expect(signedIn.dialogProps).toMatchObject({ open: true, thread, viewerId: 'u1' })
    signedIn.mounted.unmount()
    const anonymous = await mountStart(Promise.resolve({ kind: 'pending' }), null)
    expect(anonymous.dialogProps).toMatchObject({ viewerId: '' })
    anonymous.mounted.unmount()
  })
  test('AC-5..6 submits once and ignores a duplicate until the write settles', async () => {
    let resolve!: (value: unknown) => void
    const pending = new Promise<unknown>(r => { resolve = r })
    const m = await mountStart(pending)
    m.submit(); m.submit()
    expect(m.createFromThread).toHaveBeenCalledTimes(1)
    expect(m.createFromThread).toHaveBeenCalledWith('t1', body)
    resolve({ kind: 'pending' }); await settle(); m.mounted.unmount()
  })
  test('AC-7 navigates after a done response', async () => {
    const m = await mountStart(Promise.resolve({ kind: 'done', flow: { id: 'f9' } }))
    m.submit(); await settle()
    expect(m.navigateTo).toHaveBeenCalledWith('/web/flows/f9')
    m.mounted.unmount()
  })
  test('AC-8..11 pending closes dialog, toasts, does not navigate and offers approvals', async () => {
    const m = await mountStart()
    m.submit(); await settle()
    expect(m.toast.successes).toEqual([enI18n().t('fleet.flows.toast.approvalRequested')])
    expect(m.navigateTo).not.toHaveBeenCalled()
    expect(m.dialogProps?.open).toBe(false)
    expect(m.mounted.one('a')?.props.href).toBe('/web/approvals')
    m.mounted.unmount()
  })
  test.each([
    ['400 invalid input', new ApiError(400, 'Invalid input', { feature: ['Invalid input'] })],
    ['403 forbidden', new ApiError(403, 'Forbidden')],
    ['404 missing thread', new ApiError(404, 'Thread not found')],
    ['409 threadBusy', new ApiError(409, 'Conflict', { code: ['threadBusy'] })],
    ['409 notPublished', new ApiError(409, 'Conflict', { code: ['notPublished'] })],
    ['409 runnerMissing', new ApiError(409, 'Conflict', { code: ['runnerMissing'] })],
    ['409 disabled', new ApiError(409, 'Conflict', { code: ['disabled'] })],
    ['409 archived', new ApiError(409, 'Conflict', { code: ['archived'] })],
  ])('AC-12..13 rejected create (%s) reports extracted error and keeps dialog open', async (_caseName, error) => {
    let reject!: (error: Error) => void
    const failed = new Promise<unknown>((_resolve, rejectPromise) => { reject = rejectPromise })
    const m = await mountStart(failed)
    m.submit()
    reject(error)
    await settle()
    expect(m.toast.errors).toEqual([extractApiError(error)])
    expect(m.dialogProps?.open).toBe(true)
    m.mounted.unmount()
  })
})
