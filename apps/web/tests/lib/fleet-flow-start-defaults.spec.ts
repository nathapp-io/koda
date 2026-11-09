import { describe, expect, test } from '@jest/globals'
import { defaultFlowRoles, tickHint } from '~/lib/fleet-flow-start-defaults'
import type { ThreadDto, ThreadPreApproval } from '~/lib/thread-types'

const thread = (backend: ThreadDto['backend']): ThreadDto => ({
  id: 't1', kind: 'REPO', repoId: 'r1', baseRef: 'main', feature: null, title: 'Plan', createdById: 'u1',
  runnerId: 'rn1', backend, status: 'ACTIVE', archivedAt: null, skills: [], maxCostUsd: '5', costUsd: '0',
  tokens: null, specPath: null, pendingQuestion: null, session: null, lastActivityAt: '2026-01-01T00:00:00.000Z',
  createdAt: '2026-01-01T00:00:00.000Z', activeJob: null, writtenPaths: [], publishedSha: null,
  specPublished: false, lastWrite: null, preApproval: null,
})

const tick: ThreadPreApproval = { userId: 'u1', at: '2026-11-09T06:36:35.837Z', costCapUsd: '3.0000' }

describe('defaultFlowRoles', () => {
  test('AC-1 uses the native thread model for both roles', () => {
    expect(defaultFlowRoles(thread({ kind: 'native', model: 'opencode-go/deepseek-v4.1-flash' }))).toEqual({
      reviewer: 'opencode-go/deepseek-v4.1-flash', supervisor: 'opencode-go/deepseek-v4.1-flash',
    })
  })

  test('AC-2 returns empty roles when native backend has no model', () => {
    expect(defaultFlowRoles(thread({ kind: 'native' }))).toEqual({ reviewer: '', supervisor: '' })
  })

  test('AC-3 does not default ACP backend models', () => {
    expect(defaultFlowRoles(thread({ kind: 'acp', agent: 'claude', model: 'claude-sonnet' }))).toEqual({ reviewer: '', supervisor: '' })
  })
})

describe('tickHint', () => {
  test('AC-4 reports no tick', () => {
    expect(tickHint(null, 3, { userId: 'u1', isThreadCreator: true })).toBe('none')
  })

  test('AC-5 covers an equal cap for the tick owner', () => {
    expect(tickHint(tick, 3, { userId: 'u1', isThreadCreator: false })).toBe('covers')
  })

  test('AC-6 reports a cap one ten-thousandth above the tick', () => {
    expect(tickHint(tick, 3.0001, { userId: 'u1', isThreadCreator: false })).toBe('exceeded')
  })

  test('AC-7 compares fractional caps at four decimal places', () => {
    expect(tickHint({ ...tick, costCapUsd: '0.3000' }, 0.1 + 0.2, { userId: 'u1', isThreadCreator: false })).toBe('covers')
  })

  test('AC-8 covers for the thread creator', () => {
    expect(tickHint(tick, 3, { userId: 'u2', isThreadCreator: true })).toBe('covers')
  })

  test('AC-9 reports a tick owned by another viewer', () => {
    expect(tickHint(tick, 3, { userId: 'u2', isThreadCreator: false })).toBe('notYours')
  })

  test('AC-10 checks ownership before cap', () => {
    expect(tickHint(tick, 9, { userId: 'u2', isThreadCreator: false })).toBe('notYours')
  })
})
