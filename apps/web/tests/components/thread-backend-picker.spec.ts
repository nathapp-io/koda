import { describe, expect, test } from '@jest/globals'
import * as Vue from 'vue'
import { mountSfc, webFile } from '../helpers/mount-sfc'
import type { FakeNode, Mounted } from '../helpers/mount-sfc'
import { enI18n, enLocale } from '../helpers/fleet-harness'
import zhLocale from '../../i18n/locales/zh.json'
import type { AgentChoice } from '~/lib/thread-create';

/**
 * The agent/model/effort picker of the new thread form. Contract (thread-agents-modes US-011):
 * props `agents: AgentChoice[]`, `agent`, `model`, `effort`; emits `update:agent`, `update:model`
 * and `update:effort`. The agent select lists Native, Claude Code, Codex and Cursor in that order,
 * disables an agent no eligible runner can start and says why. The model and effort selects list
 * the chosen agent's own values (native keeps the fixed effort list; an effort's empty value is the
 * "default" entry that the body builders drop).
 */
const file = webFile('components', 'fleet', 'threads', 'BackendPicker.vue')

type Tree = Record<string, unknown>

/** A `t` that resolves against a real locale tree, so an assertion sees the copy a browser would. */
function localeI18n(messages: Tree) {
  const lookup = (key: string): unknown =>
    key.split('.').reduce<unknown>((node, part) => (node as Tree | undefined)?.[part], messages)
  return {
    t: (key: string): string => {
      const value = lookup(key)
      return typeof value === 'string' ? value : key
    },
    te: (): boolean => true,
  }
}

const en = localeI18n(enLocale)
const zh = localeI18n(zhLocale as Tree)

const mountPicker = (props: Record<string, unknown>, globals: Record<string, unknown> = {}) => mountSfc(file, {
  props,
  globals: { useI18n: () => en, ...globals },
})

/** One agent option as `eligibleAgents` produces it. */
const choice = (agent: AgentChoice['agent'], over: Partial<AgentChoice> = {}): AgentChoice => ({
  agent,
  available: true,
  reason: null,
  models: [],
  efforts: agent === 'native' ? ['low', 'medium', 'high', 'xhigh'] : [],
  ...over,
})

const optionValues = (app: Mounted, select: FakeNode): string[] =>
  app.find('option', select).map((option) => String(option.props.value))

const optionsOf = (app: Mounted, select: FakeNode): FakeNode[] => app.find('option', select)

const selectNamed = (app: Mounted, testid: string): FakeNode | undefined => app.one(`[data-testid="${testid}"]`)

const must = <T>(value: T | undefined, what: string): T => {
  if (value === undefined) throw new Error(`missing ${what}`)
  return value
}

const change = (select: FakeNode, value: string): void => {
  const onChange = select.props.onChange as (e: unknown) => void
  onChange({ target: { value } })
}

describe('BackendPicker agent select (US-011 AC-4, AC-5)', () => {
  test('AC-4: renders Native, Claude Code, Codex and Cursor with an unavailable agent disabled and its reason shown', () => {
    const app = mountPicker({
      agents: [
        choice('native', { models: ['m1'] }),
        choice('claude', { models: ['claude-opus-4'] }),
        choice('codex', { available: false, reason: 'notLoggedIn' }),
        choice('cursor', { available: false, reason: 'notInstalled' }),
      ],
      agent: 'native',
      model: 'm1',
      effort: '',
    })

    const select = must(selectNamed(app, 'thread-new-agent'), 'agent select')
    expect(optionValues(app, select)).toEqual(['native', 'claude', 'codex', 'cursor'])

    const labels = optionsOf(app, select).map((option) => app.textOf(option))
    expect(labels).toEqual([
      'Native',
      'Claude Code',
      'Codex — Not logged in',
      'Cursor — Not installed',
    ])

    const [native, claude, codex, cursor] = optionsOf(app, select)
    expect(must(native, 'native option').props.disabled).not.toBe(true)
    expect(must(claude, 'claude option').props.disabled).not.toBe(true)
    expect(must(codex, 'codex option').props.disabled).toBe(true)
    expect(must(cursor, 'cursor option').props.disabled).toBe(true)
    app.unmount()
  })

  test('AC-5: choosing Claude Code emits update:agent with claude, and the picker then lists Claude Code’s models', async () => {
    const app = mountPicker({
      agents: [
        choice('native', { models: ['m1'] }),
        choice('claude', { models: ['claude-sonnet-4-5', 'claude-opus-4'], efforts: ['low', 'high'] }),
      ],
      agent: 'native',
      model: 'm1',
      effort: '',
    })

    change(must(selectNamed(app, 'thread-new-agent'), 'agent select'), 'claude')

    expect(app.emitted('update:agent')).toEqual([['claude']])

    // The parent answers by re-passing the chosen agent; the model list follows it.
    app.setProps({ agent: 'claude' })
    await Vue.nextTick()

    // The empty entry is the agent's own default (F2), then Claude Code's advertised models.
    expect(optionValues(app, must(selectNamed(app, 'thread-new-model'), 'model select')))
      .toEqual(['', 'claude-sonnet-4-5', 'claude-opus-4'])
    expect(optionValues(app, must(selectNamed(app, 'thread-new-effort'), 'effort select')))
      .toEqual(['', 'low', 'high'])
    app.unmount()
  })

  test('AC-5 (edge): a native agent that offers no model shows the noBackend message instead of an empty select', () => {
    const app = mountPicker({
      agents: [choice('native', { models: [] }), choice('claude', { models: ['claude-opus-4'] })],
      agent: 'native',
      model: '',
      effort: '',
    })

    expect(app.text()).toContain('No online enabled runner offers a model for this agent.')
    expect(selectNamed(app, 'thread-new-model')).toBeUndefined()
    app.unmount()
  })

  // F2: an agent can be ready and still advertise no model (a successful probe may return an empty
  // list, and the API's acp backend takes no model at all). The form must stay usable there.
  test('F2: a ready ACP agent with no models offers the agent default and keeps its efforts', () => {
    const app = mountPicker({
      agents: [choice('native', { models: ['m1'] }), choice('claude', { models: [], efforts: ['low', 'high'] })],
      agent: 'claude',
      model: '',
      effort: '',
    })

    expect(app.text()).not.toContain('No online enabled runner offers a model for this agent.')

    const model = must(selectNamed(app, 'thread-new-model'), 'model select')
    expect(optionValues(app, model)).toEqual([''])
    expect(app.textOf(must(optionsOf(app, model)[0], 'default model option'))).toBe('Agent default')

    const effort = must(selectNamed(app, 'thread-new-effort'), 'effort select')
    expect(optionValues(app, effort)).toEqual(['', 'low', 'high'])
    app.unmount()
  })

  test('F2: a ready ACP agent with models lists the default entry first, then its models', () => {
    const app = mountPicker({
      agents: [choice('claude', { models: ['claude-opus-4'], efforts: ['high'] })],
      agent: 'claude',
      model: 'claude-opus-4',
      effort: '',
    })

    const model = must(selectNamed(app, 'thread-new-model'), 'model select')
    expect(optionValues(app, model)).toEqual(['', 'claude-opus-4'])
    // The effort list is offered for an ACP agent even when it advertises no models.
    expect(optionValues(app, must(selectNamed(app, 'thread-new-effort'), 'effort select'))).toEqual(['', 'high'])
    app.unmount()
  })
})

describe('BackendPicker disabled reasons (US-011 AC-12)', () => {
  const agents = [
    choice('native', { models: ['m1'] }),
    choice('codex', { available: false, reason: 'notLoggedIn' }),
  ]

  test('AC-12 (en): the reason reads "Not logged in"', () => {
    const app = mountPicker({ agents, agent: 'native', model: 'm1', effort: '' })

    expect(app.text()).toContain('Not logged in')
    app.unmount()
  })

  test('AC-12 (zh): the reason reads the Chinese copy', () => {
    const app = mountPicker({ agents, agent: 'native', model: 'm1', effort: '' }, { useI18n: () => zh })

    expect(app.text()).toContain('未登录')
    app.unmount()
  })
})

describe('BackendPicker (US-005 AC9-AC10, still pinned)', () => {
  test('AC9: a native agent renders an effort select whose options are default, low, medium, high and xhigh', () => {
    const app = mountPicker({ agents: [choice('native', { models: ['m1'] })], agent: 'native', model: 'm1', effort: '' })

    const effort = must(selectNamed(app, 'thread-new-effort'), 'effort select')
    expect(optionValues(app, effort)).toEqual(['', 'low', 'medium', 'high', 'xhigh'])

    // The leading option is the "default" entry: an empty value with a rendered label.
    const defaultOption = must(optionsOf(app, effort).find((option) => option.props.value === ''), 'default effort option')
    expect(app.textOf(defaultOption).length).toBeGreaterThan(0)
    app.unmount()
  })

  test('AC10: with no model offered the picker shows the noBackend message', () => {
    const app = mountPicker({ agents: [choice('native', { models: [] })], agent: 'native', model: '', effort: '' })

    expect(app.text()).toContain('No online enabled runner offers a model for this agent.')
    app.unmount()
  })

  test('a model change emits update:model with the chosen value', () => {
    const app = mountPicker({ agents: [choice('native', { models: ['m1', 'm2'] })], agent: 'native', model: 'm1', effort: '' })

    change(must(selectNamed(app, 'thread-new-model'), 'model select'), 'm2')

    expect(app.emitted('update:model')).toEqual([['m2']])
    app.unmount()
  })

  test('an effort change emits update:effort with the chosen value', () => {
    const app = mountPicker({ agents: [choice('native', { models: ['m1'] })], agent: 'native', model: 'm1', effort: '' })

    change(must(selectNamed(app, 'thread-new-effort'), 'effort select'), 'high')

    expect(app.emitted('update:effort')).toEqual([['high']])
    app.unmount()
  })

  test('the agent select labels itself from the shared i18n key', () => {
    const app = mountPicker({ agents: [choice('native', { models: ['m1'] })], agent: 'native', model: 'm1', effort: '' })

    expect(enI18n().t('fleet.threads.new.agent.label')).toBe('Agent')
    expect(app.text()).toContain('Agent')
    app.unmount()
  })
})
