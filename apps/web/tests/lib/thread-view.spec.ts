import { describe, expect, test } from '@jest/globals'
import {
  applyDelta,
  composerState,
  costText,
  isTurnRunning,
  mergeMessages,
  newClientMessageId,
  refetchAfterSeq,
  sessionLabel,
  toolChipState,
} from '~/lib/thread-view'
import type { ChatMessageDto, ThreadDetailDto, ToolSummaryEntry } from '~/lib/thread-types'

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

/** An optimistic entry: the local echo of a send, keyed by clientMessageId. */
const optimistic = (clientMessageId: string): ChatMessageDto => ({
  id: `local:${clientMessageId}`,
  clientMessageId,
  status: 'pending',
} as ChatMessageDto)

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
  ...overrides,
})

const toolEntry = (overrides: Record<string, unknown> = {}): ToolSummaryEntry => ({
  callId: 'c1',
  name: 'search_repo',
  input: '{"query":"auth"}',
  isError: null,
  preview: '',
  decidedBy: null,
  ...overrides,
})

describe('US-002 thread-view', () => {
  test('US-002 AC1: applyDelta appends the delta text to the matching message in a new array', () => {
    const messages: ChatMessageDto[] = [message({ id: 'a', status: 'streaming', content: 'He' })]
    const result = applyDelta(messages, 'a', 'llo')

    expect(result).not.toBeNull()
    expect(result).not.toBe(messages)
    expect(result?.length).toBe(1)
    expect(result?.[0].content).toBe('Hello')
    // The call must not mutate the input list it was handed.
    expect(messages[0].content).toBe('He')
  })

  test('US-002 AC3: mergeMessages drops the optimistic entry once incoming holds a message with its clientMessageId', () => {
    const m5 = message({ id: 'm5', seq: 5, clientMessageId: 'c1', status: 'pending' })
    const result = mergeMessages([optimistic('c1')], [m5])

    expect(result).toEqual([m5])
    expect(result.map(m => m.id)).toEqual(['m5'])
  })

  test('US-002 AC4: mergeMessages orders real messages by seq with optimistic entries last', () => {
    const current: ChatMessageDto[] = [
      message({ id: 'm1', seq: 1 }),
      optimistic('c2'),
    ]
    const result = mergeMessages(current, [message({ id: 'm2', seq: 2 })])

    expect(result.map(m => m.id)).toEqual(['m1', 'm2', 'local:c2'])
  })

  test('US-002 AC5: refetchAfterSeq asks to refetch before the oldest in-flight message', () => {
    const messages: ChatMessageDto[] = [
      message({ id: 'm1', seq: 1, status: 'complete' }),
      message({ id: 'm2', seq: 2, status: 'streaming' }),
      message({ id: 'm3', seq: 3, status: 'pending' }),
    ]

    expect(refetchAfterSeq(messages)).toBe(1)
  })

  test('US-002 AC6: sessionLabel reports closing while the active job uploads', () => {
    expect(sessionLabel(thread({ activeJob: { id: 'j1', state: 'UPLOADING' }, session: null }))).toBe('closing')
  })

  test('US-002 AC7: composerState marks a non-creator as read-only even when no turn runs', () => {
    const t = thread({ sendRefusal: null })
    expect(composerState(t, [], { userId: 'u2', isCreator: false })).toEqual({ canSend: false, reason: 'readOnly' })
  })

  test('US-002 AC8: composerState reports a running turn while a message streams', () => {
    const t = thread({ sendRefusal: null })
    const messages: ChatMessageDto[] = [message({ id: 'm1', seq: 1, role: 'assistant', status: 'streaming', content: '' })]

    expect(composerState(t, messages, { userId: 'u1', isCreator: true })).toEqual({ canSend: false, reason: 'turnRunning' })
  })

  test('US-002 AC9: toolChipState reports unfinished for a tool entry that never resolved', () => {
    expect(toolChipState(toolEntry({ isError: null, decidedBy: null }), 'cancelled')).toBe('unfinished')
  })

  test('US-002: composerState lets the creator send when the API refusal is null and no turn runs', () => {
    expect(composerState(thread({ sendRefusal: null }), [], { userId: 'u1', isCreator: true })).toEqual({ canSend: true, reason: null })
  })

  test('US-002: composerState puts the API refusal ahead of a running turn', () => {
    const t = thread({ sendRefusal: 'costCap' })
    const messages: ChatMessageDto[] = [message({ id: 'm1', seq: 1, status: 'streaming' })]

    expect(composerState(t, messages, { userId: 'u1', isCreator: true })).toEqual({ canSend: false, reason: 'costCap' })
  })

  test('US-002: sessionLabel falls through to none when there is no session and no active job', () => {
    expect(sessionLabel(thread({ activeJob: null, session: null }))).toBe('none')
  })

  test('US-002: toolChipState reports denied when the profile decided the call, even while streaming', () => {
    expect(toolChipState(toolEntry({ isError: null, decidedBy: 'profile' }), 'streaming')).toBe('denied')
  })

  test('US-002: mergeMessages lets an incoming snapshot replace a complete message of the same id', () => {
    const current: ChatMessageDto[] = [message({ id: 'm1', seq: 1, status: 'complete', content: 'stale' })]
    const incoming: ChatMessageDto[] = [message({ id: 'm1', seq: 1, status: 'complete', content: 'fresh' })]

    expect(mergeMessages(current, incoming)).toEqual(incoming)
  })

  test('US-002: mergeMessages never shortens a message streaming on both sides', () => {
    const current: ChatMessageDto[] = [message({ id: 'm1', seq: 1, status: 'streaming', content: 'Hello world' })]
    const incoming: ChatMessageDto[] = [message({ id: 'm1', seq: 1, status: 'streaming', content: 'Hello' })]

    const result = mergeMessages(current, incoming)
    expect(result).toHaveLength(1)
    expect(result[0].content).toBe('Hello world')
  })

  test('US-002: isTurnRunning is true while any message is pending or streaming', () => {
    expect(isTurnRunning([message({ id: 'm1', seq: 1, status: 'pending' })])).toBe(true)
    expect(isTurnRunning([message({ id: 'm1', seq: 1, status: 'streaming' })])).toBe(true)
    expect(isTurnRunning([message({ id: 'm1', seq: 1, status: 'complete' })])).toBe(false)
    expect(isTurnRunning([])).toBe(false)
  })

  test('US-002: newClientMessageId returns a fresh id matching the clientMessageId format', () => {
    const a = newClientMessageId()
    const b = newClientMessageId()

    expect(a).toMatch(/^[A-Za-z0-9_-]{1,64}$/)
    expect(b).toMatch(/^[A-Za-z0-9_-]{1,64}$/)
    expect(a).not.toBe(b)
  })

  test('US-002: costText shows the thread money exactly as received through usd()', () => {
    expect(costText({ costUsd: '1.25', maxCostUsd: '5' })).toBe('$1.25 / $5')
    expect(costText({ costUsd: '0', maxCostUsd: '5' })).toBe('$0 / $5')
  })
})