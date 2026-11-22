import { describe, expect, jest, test } from '@jest/globals'
import { mountSfc, webFile } from '../helpers/mount-sfc'
import type { FakeNode } from '../helpers/mount-sfc'
import { enI18n } from '../helpers/fleet-harness'
import { formatDateTime } from '~/lib/format-date-time'
import type { AgentChoice } from '~/lib/thread-create'

const file = webFile('components', 'fleet', 'threads', 'AgentReadinessNotice.vue')
const checkedAt = '2026-11-22T02:00:00.000Z'
const choice = (over: Partial<AgentChoice> = {}): AgentChoice => ({
  agent: 'codex',
  available: false,
  reason: 'notReady',
  probe: { code: 'timeout', checkedAt, runnerIds: ['r1', 'r2'] },
  models: [],
  efforts: [],
  ...over,
})
const mountNotice = (props: Record<string, unknown> = {}) => mountSfc(file, {
  props: { choice: choice(), canRecheck: true, rechecking: false, ...props },
  globals: { useI18n: () => ({ ...enI18n(), locale: { value: 'en' } }) },
})
const must = <T>(value: T | undefined, what: string): T => {
  if (value === undefined) throw new Error(`missing ${what}`)
  return value
}
const readiness = (app: ReturnType<typeof mountSfc>): FakeNode | undefined => app.one('[data-testid="agent-readiness-codex"]')

describe('AgentReadinessNotice (US-008)', () => {
  test('AC-1: renders the localized probe failure reason inside the agent notice', () => {
    const app = mountNotice()
    expect(app.textOf(must(readiness(app), 'readiness notice'))).toContain(enI18n().t('fleet.threads.new.agent.probe.timeout'))
    app.unmount()
  })

  test('AC-2: renders checked-at through the shared local date formatter', () => {
    const formatted = formatDateTime(checkedAt, 'en')
    const dateTime = jest.fn((iso: string | null | undefined) => iso === checkedAt ? formatted : '-')
    const app = mountSfc(file, {
      props: { choice: choice(), canRecheck: true, rechecking: false },
      globals: { useI18n: () => ({ ...enI18n(), locale: { value: 'en' } }) },
      alias: { '~/lib/local-dates': { useLocalDates: () => ({ dateTime, date: () => '-' }) } },
    })
    const notice = must(readiness(app), 'readiness notice')
    expect(dateTime).toHaveBeenCalledWith(checkedAt)
    expect(app.textOf(notice)).toContain(enI18n().t('fleet.threads.new.agent.checkedAt', { time: formatted }))
    app.unmount()
  })

  test('AC-3: uses unconfirmed when a not-ready probe has no code', () => {
    const app = mountNotice({ choice: choice({ probe: { code: null, checkedAt, runnerIds: ['r1'] } }) })
    expect(app.textOf(must(readiness(app), 'readiness notice'))).toContain(enI18n().t('fleet.threads.new.agent.probe.unconfirmed'))
    app.unmount()
  })

  test('AC-4: uses notLoggedIn when a not-logged-in probe has no code', () => {
    const app = mountNotice({ choice: choice({ reason: 'notLoggedIn', probe: { code: null, checkedAt, runnerIds: ['r1'] } }) })
    expect(app.textOf(must(readiness(app), 'readiness notice'))).toContain(enI18n().t('fleet.threads.new.agent.probe.notLoggedIn'))
    app.unmount()
  })

  test('AC-5: omits checked-at text when checkedAt is null', () => {
    const app = mountNotice({ choice: choice({ probe: { code: 'timeout', checkedAt: null, runnerIds: ['r1'] } }) })
    expect(app.textOf(must(readiness(app), 'readiness notice'))).not.toContain('Last checked')
    app.unmount()
  })

  test('AC-6: hides the re-check button when permission is absent', () => {
    const app = mountNotice({ canRecheck: false })
    expect(app.one('[data-testid="agent-recheck-codex"]')).toBeUndefined()
    app.unmount()
  })

  test('AC-7: clicking re-check emits the recheck event once', () => {
    const app = mountNotice()
    const button = must(app.one('[data-testid="agent-recheck-codex"]'), 're-check button')
    const onClick = button.props.onClick as (() => void) | undefined
    must(onClick, 'button click handler')()
    expect(app.emitted('recheck')).toEqual([[]])
    app.unmount()
  })

  test('AC-8: shows the rechecking copy and disables the re-check button while busy', () => {
    const app = mountNotice({ rechecking: true })
    const button = must(app.one('[data-testid="agent-recheck-codex"]'), 're-check button')
    expect(button.props.disabled).toBe(true)
    expect(app.textOf(button)).toContain(enI18n().t('fleet.threads.new.agent.rechecking'))
    app.unmount()
  })

  test('AC-9: renders no notice when the choice has no probe', () => {
    const app = mountNotice({ choice: choice({ probe: undefined }) })
    expect(readiness(app)).toBeUndefined()
    app.unmount()
  })
})
