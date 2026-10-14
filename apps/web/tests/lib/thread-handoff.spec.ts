import { describe, expect, test } from '@jest/globals'
import { handoffActionState, isHandoffBusy } from '~/lib/thread-handoff'
import type { ChatMessageDto, ThreadDetailDto, ThreadHandoffJob } from '~/lib/thread-types'

const message = (overrides: Record<string, unknown> = {}): ChatMessageDto => ({
  id: 'm1',
  seq: 1,
  jobId: 'j1',
  turnId: 't1',
  role: 'assistant',
  authorUserId: 'u1',
  clientMessageId: null,
  content: '',
  toolSummary: null,
  status: 'complete',
  errorReason: null,
  usage: null,
  costUsd: null,
  costSource: null,
  createdAt: '2026-10-14T00:00:00.000Z',
  ...overrides,
})

const job = (state: string, overrides: Partial<ThreadHandoffJob> = {}): ThreadHandoffJob => ({
  jobId: 'hj1',
  state,
  stateReason: null,
  ...overrides,
})

const thread = (overrides: Record<string, unknown> = {}): ThreadDetailDto => ({
  id: 't1',
  repoId: 'r1',
  baseRef: 'main',
  feature: 'f1',
  title: 'Plan the auth flow',
  createdById: 'u1',
  runnerId: 'rn1',
  backend: { kind: 'native', model: 'gpt-5' },
  status: 'ACTIVE',
  archivedAt: null,
  skills: [],
  maxCostUsd: '5',
  costUsd: '0',
  tokens: null,
  specPath: '.nax/features/f1/prd.json',
  pendingQuestion: null,
  session: null,
  lastActivityAt: '2026-10-14T00:00:00.000Z',
  createdAt: '2026-10-14T00:00:00.000Z',
  activeJob: null,
  sendRefusal: null,
  writtenPaths: [],
  publishedSha: null,
  specPublished: false,
  lastWrite: null,
  handoff: { plan: null, run: null },
  ...overrides,
})

describe('US-001 thread handoff action rules', () => {
  test('US-001 AC1: isHandoffBusy returns true for a thread whose handoff.run has state RUNNING', () => {
    const t = thread({ handoff: { plan: job('COMPLETED'), run: job('RUNNING') } })

    expect(isHandoffBusy(t)).toBe(true)
  })

  test('US-001 AC2: isHandoffBusy returns false for a thread whose handoff.plan has state COMPLETED and whose handoff.run is null', () => {
    const t = thread({ handoff: { plan: job('COMPLETED'), run: null } })

    expect(isHandoffBusy(t)).toBe(false)
  })

  test('US-001 AC3: handoffActionState(thread, [], publish) returns nothingToPublish when writtenPaths is []', () => {
    const t = thread({ writtenPaths: [] })

    expect(handoffActionState(t, [], 'publish')).toEqual({ enabled: false, reason: 'nothingToPublish' })
  })

  test('US-001 AC4: handoffActionState(thread, [], publish) returns handoffBusy when a path is written and handoff.plan is QUEUED', () => {
    const t = thread({
      writtenPaths: ['.nax/features/f/spec.md'],
      handoff: { plan: job('QUEUED'), run: null },
    })

    expect(handoffActionState(t, [], 'publish')).toEqual({ enabled: false, reason: 'handoffBusy' })
  })

  test('US-001 AC5: handoffActionState(thread, messages, publish) returns turnRunning when a message is streaming', () => {
    const t = thread({ writtenPaths: ['.nax/features/f/spec.md'] })
    const messages = [message({ id: 'm1', seq: 1, status: 'streaming' })]

    expect(handoffActionState(t, messages, 'publish')).toEqual({ enabled: false, reason: 'turnRunning' })
  })

  test('US-001 AC6: handoffActionState(thread, [], publish) returns turnRunning when the active job is UPLOADING', () => {
    const t = thread({
      writtenPaths: ['.nax/features/f/spec.md'],
      activeJob: { id: 'j1', state: 'UPLOADING' },
    })

    expect(handoffActionState(t, [], 'publish')).toEqual({ enabled: false, reason: 'turnRunning' })
  })

  test('US-001 AC7: handoffActionState(thread, [], publish) is enabled when the active job is RUNNING with no turn running', () => {
    const t = thread({
      writtenPaths: ['.nax/features/f/spec.md'],
      activeJob: { id: 'j1', state: 'RUNNING' },
    })

    expect(handoffActionState(t, [], 'publish')).toEqual({ enabled: true, reason: null })
  })

  test('US-001 AC8: handoffActionState(thread, [], plan) returns notPublished when specPublished is false and activeJob is non-null', () => {
    const t = thread({ specPublished: false, activeJob: { id: 'j1', state: 'RUNNING' } })

    expect(handoffActionState(t, [], 'plan')).toEqual({ enabled: false, reason: 'notPublished' })
  })

  test('US-001 AC9: handoffActionState(thread, [], plan) returns sessionActive when specPublished is true, handoff is idle and activeJob is non-null', () => {
    const t = thread({
      specPublished: true,
      handoff: { plan: null, run: null },
      activeJob: { id: 'j1', state: 'RUNNING' },
    })

    expect(handoffActionState(t, [], 'plan')).toEqual({ enabled: false, reason: 'sessionActive' })
  })

  test('US-001 AC10: handoffActionState(thread, [], plan) is enabled when specPublished is true, handoff is idle and activeJob is null', () => {
    const t = thread({
      specPublished: true,
      handoff: { plan: null, run: null },
      activeJob: null,
    })

    expect(handoffActionState(t, [], 'plan')).toEqual({ enabled: true, reason: null })
  })

  test('US-001 AC11: handoffActionState(thread, [], run) returns notPlanned when handoff.plan is null', () => {
    const t = thread({ handoff: { plan: null, run: null } })

    expect(handoffActionState(t, [], 'run')).toEqual({ enabled: false, reason: 'notPlanned' })
  })

  test('US-001 AC12: handoffActionState(thread, [], run) returns handoffBusy when handoff.plan is QUEUED', () => {
    const t = thread({ handoff: { plan: job('QUEUED'), run: null } })

    expect(handoffActionState(t, [], 'run')).toEqual({ enabled: false, reason: 'handoffBusy' })
  })

  test('US-001 AC13: handoffActionState(thread, [], run) returns planNotCompleted when handoff.plan is FAILED and handoff.run is null', () => {
    const t = thread({ handoff: { plan: job('FAILED'), run: null } })

    expect(handoffActionState(t, [], 'run')).toEqual({ enabled: false, reason: 'planNotCompleted' })
  })

  test('US-001 AC14: handoffActionState(thread, [], run) returns sessionActive when the plan is COMPLETED and activeJob is non-null', () => {
    const t = thread({
      handoff: { plan: job('COMPLETED'), run: null },
      activeJob: { id: 'j1', state: 'RUNNING' },
    })

    expect(handoffActionState(t, [], 'run')).toEqual({ enabled: false, reason: 'sessionActive' })
  })

  test('US-001 AC15: handoffActionState(thread, [], discard) returns sessionActive when handoff is idle and activeJob is non-null', () => {
    const t = thread({
      handoff: { plan: null, run: null },
      activeJob: { id: 'j1', state: 'RUNNING' },
    })

    expect(handoffActionState(t, [], 'discard')).toEqual({ enabled: false, reason: 'sessionActive' })
  })
})
