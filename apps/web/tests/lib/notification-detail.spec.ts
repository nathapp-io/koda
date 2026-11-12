import { describe, expect, test } from '@jest/globals'
import { enI18n } from '../helpers/fleet-harness'
import { notificationDetail, notificationText } from '~/lib/notifications'
import type { NotificationDto } from '~/lib/notification-types'
import en from '../../i18n/locales/en.json'
import zh from '../../i18n/locales/zh.json'

const base: NotificationDto = {
  id: 'n1', category: 'FLEET_NEEDS_YOU', kind: 'flow_stopped', title: 'Flow stopped',
  body: 'SPEC_REVIEW job cmw82: no verdict JSON', link: '/acme/flows/f12',
  params: { flowId: 'f12', feature: 'f12-max', stopReason: 'verdict_unreadable' },
  projectId: 'p1', actorId: null, readAt: null, createdAt: '2026-10-08T00:00:00.000Z',
}

describe('notificationDetail', () => {
  test('AC-1 returns the translated flow stop reason', () => {
    expect(notificationDetail(base, enI18n())).toBe('Verdict unreadable')
  })
  test('AC-2 humanizes an unknown stop reason', () => {
    expect(notificationDetail({ ...base, params: { ...base.params, stopReason: 'brand_new_reason' } }, enI18n())).toBe('Brand new reason')
  })
  test('AC-3 returns the body when no stop reason is present', () => {
    expect(notificationDetail({ ...base, params: { flowId: 'f12' } }, enI18n())).toBe(base.body)
  })
  test('AC-4 leaves other notification bodies unchanged', () => {
    expect(notificationDetail({ ...base, kind: 'job_failed' }, enI18n())).toBe(base.body)
  })
  test('AC-12 returns the body for a non-string stop reason', () => {
    expect(notificationDetail({ ...base, params: { stopReason: 42 } }, enI18n())).toBe(base.body)
  })
  test('AC-5 words the flow stopped notification from its feature param', () => {
    expect(notificationText(base, enI18n())).toBe('Flow f12-max stopped')
  })
  test('AC-11 all added English and Chinese messages are present', () => {
    const stopReasons = ['step_failed', 'verdict_unreadable', 'review_findings', 'review_ambiguous', 'calls_failed', 'plan_no_result', 'run_no_pr', 'pr_not_ready', 'cost_cap', 'creator_lost_access', 'budget_paused', 'dispatch_refused', 'pr_closed', 'spec_changed', 'human_stop', 'approval_rejected']
    const keys = ['notifications.kinds.flow_stopped', 'notifications.kinds.flow_questions', 'kb.search.promptTitle', 'kb.search.promptHint', 'kb.documents.emptyHint', ...stopReasons.map(reason => `fleet.flows.stopReason.${reason}`)]
    const valueAt = (root: unknown, path: string): unknown => path.split('.').reduce<unknown>((value, key) => value && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined, root)
    for (const locale of [en, zh]) for (const key of keys) expect(valueAt(locale, key)).toEqual(expect.any(String))
    for (const locale of [en, zh]) for (const key of keys) expect(String(valueAt(locale, key)).trim()).not.toBe('')
  })
})
