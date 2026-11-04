import { describe, expect, test } from '@jest/globals'
import {
  AGENT_CHOICE_KEYS, agentLabelKey, agentReasonKey, buildThreadCreateSchema, eligibleAgents, threadModeChoices,
  toCreateThreadBody,
} from '~/lib/thread-create'
import type { AgentChoice, ThreadCreateValues } from '~/lib/thread-create'
import type { FleetRunnerSummary } from '~/lib/fleet-types'
import { toCreateWorkspaceThreadBody } from '~/lib/workspace-thread-create'
import type { ThreadAcpOffer, ThreadAgent } from '~/lib/thread-types'

/**
 * thread-agents-modes US-011: the new-thread forms offer Native, Claude Code, Codex and Cursor, and
 * disable an agent no eligible runner can start. These helpers decide that from the runner summaries
 * the API sends (`threadBackends.native` / `acp` plus the `acpOffers` discovery detail), and the body
 * builders turn the chosen agent and mode into the create request the API reads.
 */

const t = (key: string): string => key
const schema = buildThreadCreateSchema(t)

/** One runner summary as the API sends it; `threadBackends` is always present. */
const runner = (over: Partial<FleetRunnerSummary> = {}): FleetRunnerSummary => ({
  id: 'rn1',
  name: 'mac-1',
  os: 'linux',
  arch: 'x64',
  labels: [],
  enabled: true,
  online: true,
  profiles: [],
  threadBackends: { native: [], acp: [] },
  ...over,
})

/** One ACP discovery offer (runner-summary.dto.ts `ThreadAcpOffer`). */
const offer = (agent: ThreadAgent, over: Partial<ThreadAcpOffer> = {}): ThreadAcpOffer => ({
  agent,
  launchable: true,
  loggedIn: true,
  models: [],
  efforts: [],
  ...over,
})

const agentOf = (choices: readonly AgentChoice[], agent: string): AgentChoice => {
  const found = choices.find(choice => choice.agent === agent)
  if (found === undefined) throw new Error(`missing agent ${agent} in ${choices.map(choice => choice.agent).join(',')}`)
  return found
}

describe('eligibleAgents (US-011 AC-1..AC-3)', () => {
  test('AC-1: claude offered launchable and logged in is available with its models', () => {
    const choices = eligibleAgents([
      runner({
        threadBackends: {
          native: ['m1'],
          acp: ['claude'],
          acpOffers: [offer('claude', { models: ['claude-sonnet-4-5', 'claude-opus-4'], efforts: ['high', 'low'] })],
        },
      }),
    ], 'REPO')

    const claude = agentOf(choices, 'claude')
    expect(claude.available).toBe(true)
    expect(claude.reason).toBeNull()
    expect(claude.models).toEqual(['claude-opus-4', 'claude-sonnet-4-5'])
    expect(claude.efforts).toEqual(['high', 'low'])
  })

  // F1 (round 2): placement admits an ACP thread only on a runner whose `acp` lists the agent, so an
  // offer alone — even a logged-in one — must not enable an agent every eligible runner omits from `acp`.
  test('AC-1 (offers only): a launchable, logged-in offer without an acp listing is not available', () => {
    const choices = eligibleAgents([
      runner({ threadBackends: { native: [], acp: [], acpOffers: [offer('claude', { models: ['claude-opus-4'] })] } }),
    ], 'REPO')

    const claude = agentOf(choices, 'claude')
    expect(claude.available).toBe(false)
    // Launchable and logged in, so neither "not installed" nor "not logged in": the runner just does
    // not report the agent ready.
    expect(claude.reason).toBe('notReady')
    expect(claude.models).toEqual([])
  })

  test('AC-1 (offers only, edge): one runner that does list it in acp is still enough', () => {
    const choices = eligibleAgents([
      runner({ id: 'offers-only', threadBackends: { native: [], acp: [], acpOffers: [offer('claude', { models: ['claude-opus-4'] })] } }),
      runner({ id: 'ready', threadBackends: { native: [], acp: ['claude'], acpOffers: [offer('claude', { models: ['claude-opus-4'] })] } }),
    ], 'REPO')

    expect(agentOf(choices, 'claude')).toMatchObject({ available: true, reason: null, models: ['claude-opus-4'] })
  })

  test('AC-2: codex launchable but logged out on every eligible runner is unavailable with reason notLoggedIn', () => {
    const choices = eligibleAgents([
      runner({ id: 'a', threadBackends: { native: [], acp: [], acpOffers: [offer('codex', { loggedIn: false })] } }),
      runner({ id: 'b', threadBackends: { native: [], acp: [], acpOffers: [offer('codex', { loggedIn: false, models: ['gpt-5-codex'] })] } }),
    ], 'REPO')

    const codex = agentOf(choices, 'codex')
    expect(codex.available).toBe(false)
    expect(codex.reason).toBe('notLoggedIn')
    // An agent that cannot be started offers no model to pick.
    expect(codex.models).toEqual([])
  })

  test('AC-3: cursor that no eligible runner reports launchable is unavailable with reason notInstalled', () => {
    const choices = eligibleAgents([
      runner({ id: 'a', threadBackends: { native: [], acp: [], acpOffers: [offer('cursor', { launchable: false, loggedIn: null })] } }),
      runner({ id: 'b', threadBackends: { native: ['m1'], acp: [] } }),
    ], 'REPO')

    const cursor = agentOf(choices, 'cursor')
    expect(cursor.available).toBe(false)
    expect(cursor.reason).toBe('notInstalled')
    expect(cursor.models).toEqual([])
  })

  test('AC-4 support: the helper answers all four choices in select order', () => {
    expect(AGENT_CHOICE_KEYS).toEqual(['native', 'claude', 'codex', 'cursor'])
    expect(eligibleAgents([], 'REPO').map(choice => choice.agent)).toEqual(['native', 'claude', 'codex', 'cursor'])
  })

  test('AC-2 (edge): one logged-in runner keeps the agent available and contributes its models', () => {
    const choices = eligibleAgents([
      runner({ id: 'a', threadBackends: { native: [], acp: [], acpOffers: [offer('codex', { loggedIn: false, models: ['gpt-5-codex-mini'] })] } }),
      runner({ id: 'b', threadBackends: { native: [], acp: ['codex'], acpOffers: [offer('codex', { models: ['gpt-5-codex', 'gpt-5-codex-mini'] })] } }),
    ], 'REPO')

    const codex = agentOf(choices, 'codex')
    expect(codex.available).toBe(true)
    expect(codex.models).toEqual(['gpt-5-codex', 'gpt-5-codex-mini'])
  })

  // F1: placement admits an ACP thread only when some runner's `acp` lists the agent, so readiness
  // follows the eligible runners' `acp` lists — never the presence or absence of discovery detail.
  test('F1: a ready runner without offers keeps the agent available even when another reports it logged out', () => {
    const choices = eligibleAgents([
      runner({ id: 'ready', threadBackends: { native: [], acp: ['codex'] } }),
      runner({ id: 'logged-out', threadBackends: { native: [], acp: [], acpOffers: [offer('codex', { loggedIn: false, models: ['gpt-5-codex'] })] } }),
    ], 'REPO')

    const codex = agentOf(choices, 'codex')
    expect(codex.available).toBe(true)
    expect(codex.reason).toBeNull()
    // A logged-out offer validates nothing, so it contributes no model.
    expect(codex.models).toEqual([])
  })

  test('F1: a runner whose offer is not launchable still cannot make the agent unavailable when another is ready', () => {
    const choices = eligibleAgents([
      runner({ id: 'ready', threadBackends: { native: [], acp: ['cursor'] } }),
      runner({ id: 'absent', threadBackends: { native: [], acp: [], acpOffers: [offer('cursor', { launchable: false })] } }),
    ], 'REPO')

    expect(agentOf(choices, 'cursor')).toMatchObject({ available: true, reason: null })
  })

  test('F1: loggedIn null is never confirmed readiness, and its reason is never "not logged in"', () => {
    const choices = eligibleAgents([
      runner({ threadBackends: { native: [], acp: [], acpOffers: [offer('claude', { loggedIn: null })] } }),
    ], 'REPO')

    const claude = agentOf(choices, 'claude')
    expect(claude.available).toBe(false)
    // Launchable, so not "not installed"; login unknown, so not "not logged in" either.
    expect(claude.reason).toBe('notReady')
    expect(claude.models).toEqual([])
  })

  test('F1: an unknown-login agent that a runner does list in acp is available', () => {
    const choices = eligibleAgents([
      runner({ id: 'ready', threadBackends: { native: [], acp: ['claude'], acpOffers: [offer('claude', { loggedIn: true, models: ['claude-opus-4'] })] } }),
      runner({ id: 'unknown', threadBackends: { native: [], acp: [], acpOffers: [offer('claude', { loggedIn: null, models: ['claude-sonnet-4-5'] })] } }),
    ], 'REPO')

    const claude = agentOf(choices, 'claude')
    expect(claude.available).toBe(true)
    expect(claude.reason).toBeNull()
    expect(claude.models).toEqual(['claude-opus-4'])
  })

  test('AC-1 (scope): an offline or disabled runner contributes no agent, model or effort', () => {
    const offers = [offer('claude', { models: ['claude-opus-4'], efforts: ['high'] })]
    const choices = eligibleAgents([
      runner({ id: 'offline', online: false, threadBackends: { native: ['m9'], acp: [], acpOffers: offers } }),
      runner({ id: 'disabled', enabled: false, threadBackends: { native: ['m8'], acp: [], acpOffers: offers } }),
      runner({ id: 'no-project', projectThreads: false, threadBackends: { native: ['m7'], acp: [], acpOffers: offers } }),
    ], 'PROJECT')

    expect(agentOf(choices, 'claude')).toMatchObject({ available: false, reason: 'notInstalled', models: [] })
    expect(agentOf(choices, 'native')).toMatchObject({ available: false, reason: 'notInstalled', models: [] })
  })

  test('AC-1: a runner that sends no acpOffers still answers through its acp list', () => {
    const choices = eligibleAgents([
      runner({ workspaceThreads: true, threadBackends: { native: ['m1'], acp: ['cursor'] } }),
    ], 'WORKSPACE')

    expect(agentOf(choices, 'cursor')).toMatchObject({ available: true, reason: null })
    expect(agentOf(choices, 'claude')).toMatchObject({ available: false, reason: 'notInstalled' })
    // Native models still come from threadBackends.native, as before this story.
    expect(agentOf(choices, 'native').models).toEqual(['m1'])
  })

  test('AC-5 support: the picker reads its labels and reasons through one key pair', () => {
    expect(agentLabelKey('claude')).toBe('fleet.threads.new.agent.claude')
    expect(agentLabelKey('native')).toBe('fleet.threads.new.agent.native')
    expect(agentReasonKey('notInstalled')).toBe('fleet.threads.new.agent.reason.notInstalled')
    expect(agentReasonKey('notLoggedIn')).toBe('fleet.threads.new.agent.reason.notLoggedIn')
  })
})

describe('threadModeChoices (US-011 AC-6..AC-8)', () => {
  test('AC-6: only Read and Ask when the caller holds thread.mode.ask but not thread.mode.full', () => {
    const held = new Set(['thread.create', 'thread.mode.ask'])
    expect(threadModeChoices(key => held.has(key))).toEqual(['read', 'ask'])
  })

  test('AC-7: Read, Ask and Full when the caller holds both mode keys', () => {
    const held = new Set(['thread.create', 'thread.mode.ask', 'thread.mode.full'])
    expect(threadModeChoices(key => held.has(key))).toEqual(['read', 'ask', 'full'])
  })

  test('AC-6 (edge): Read alone when the caller holds no mode key', () => {
    expect(threadModeChoices(() => false)).toEqual(['read'])
  })

  test('AC-7 (edge): Full does not imply Ask — the keys are independent', () => {
    const held = new Set(['thread.mode.full'])
    expect(threadModeChoices(key => held.has(key))).toEqual(['read', 'full'])
  })
})

describe('toCreateThreadBody agent and mode (US-011 AC-9..AC-11)', () => {
  const repoValues = (over: Partial<ThreadCreateValues> = {}): ThreadCreateValues => ({
    kind: 'REPO',
    repoId: 'r1',
    baseRef: '',
    feature: 'add-auth',
    title: 'Auth spec',
    maxCostUsd: '5',
    agent: 'native',
    mode: 'read',
    model: 'm1',
    effort: '',
    ...over,
  })

  test('AC-9 support: an ACP agent with its own model carries agent, model and the chosen mode', () => {
    const body = toCreateThreadBody(repoValues({ agent: 'codex', model: 'gpt-5-codex', mode: 'ask' }))

    expect(body).toEqual({
      kind: 'REPO',
      repoId: 'r1',
      feature: 'add-auth',
      title: 'Auth spec',
      maxCostUsd: 5,
      backend: { kind: 'acp', agent: 'codex', model: 'gpt-5-codex' },
      mode: 'ask',
    })
  })

  test('AC-10 support: Native keeps a native backend and an unchanged mode of read', () => {
    const body = toCreateThreadBody(repoValues())

    expect(body).toEqual({
      kind: 'REPO',
      repoId: 'r1',
      feature: 'add-auth',
      title: 'Auth spec',
      maxCostUsd: 5,
      backend: { kind: 'native', model: 'm1' },
      mode: 'read',
    })
  })

  test('AC-11 support: a PROJECT body carries an acp backend and never a mode', () => {
    const body = toCreateThreadBody(repoValues({ kind: 'PROJECT', agent: 'cursor', model: 'cursor-small', mode: 'ask' }))

    expect(body).toEqual({
      kind: 'PROJECT',
      title: 'Auth spec',
      maxCostUsd: 5,
      backend: { kind: 'acp', agent: 'cursor', model: 'cursor-small' },
    })
    expect(body).not.toHaveProperty('mode')
  })

  test('AC-9 support: an ACP effort travels inside the backend', () => {
    const body = toCreateThreadBody(repoValues({ agent: 'claude', model: 'claude-opus-4', effort: 'xhigh' }))

    expect(body.backend).toEqual({ kind: 'acp', agent: 'claude', model: 'claude-opus-4', effort: 'xhigh' })
  })

  test('the schema accepts an ACP model id with an option suffix and refuses a bad one', () => {
    expect(schema.safeParse(repoValues({ agent: 'claude', model: 'gpt-5.5[context=272k,reasoning=medium]' })).success).toBe(true)
    expect(schema.safeParse(repoValues({ agent: 'claude', model: 'bad model!' })).success).toBe(false)
  })

  test('the schema still requires a model for a native backend', () => {
    expect(schema.safeParse(repoValues({ model: '' })).success).toBe(false)
    // An ACP agent may advertise no model: the API takes an acp backend without one.
    expect(schema.safeParse(repoValues({ agent: 'cursor', model: '' })).success).toBe(true)
    expect(toCreateThreadBody(repoValues({ agent: 'cursor', model: '' })).backend).toEqual({ kind: 'acp', agent: 'cursor' })
  })

  test('the schema accepts an ACP effort outside the native set and refuses a bad one', () => {
    expect(schema.safeParse(repoValues({ agent: 'codex', model: 'gpt-5-codex', effort: 'minimal' })).success).toBe(true)
    expect(schema.safeParse(repoValues({ agent: 'codex', model: 'gpt-5-codex', effort: 'HIGH RISK' })).success).toBe(false)
  })
})

describe('toCreateWorkspaceThreadBody agent (US-011 AC-11)', () => {
  test('AC-11 support: a WORKSPACE body carries an acp backend and never a mode', () => {
    const body = toCreateWorkspaceThreadBody({
      homeProject: '', title: 'Plan', agent: 'cursor', model: 'cursor-large', effort: 'high', maxCostUsd: 5,
    })

    expect(body).toEqual({
      title: 'Plan',
      maxCostUsd: 5,
      backend: { kind: 'acp', agent: 'cursor', model: 'cursor-large', effort: 'high' },
    })
    expect(body).not.toHaveProperty('mode')
  })

  test('AC-11 support: the workspace default stays a native backend', () => {
    const body = toCreateWorkspaceThreadBody({ homeProject: '', title: 'Plan', agent: 'native', model: 'm1', effort: '', maxCostUsd: 5 })

    expect(body.backend).toEqual({ kind: 'native', model: 'm1' })
  })
})
