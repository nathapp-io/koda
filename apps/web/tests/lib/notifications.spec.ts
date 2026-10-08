import { describe, expect, test } from '@jest/globals'
import { enI18n } from '../helpers/fleet-harness'
import { isInAppPath, notificationText } from '~/lib/notifications'
import { NOTIFICATION_CATEGORIES } from '~/lib/notification-types'
import type { NotificationDto } from '~/lib/notification-types'

const base: NotificationDto = {
  id: 'n1', category: 'ASSIGNED', kind: 'ticket_assigned', title: 'Ann assigned you KODA-1: Fix login',
  body: null, link: '/koda/tickets/KODA-1', params: { ref: 'KODA-1', ticketTitle: 'Fix login', actorName: 'Ann' },
  projectId: 'p1', actorId: 'u2', readAt: null, createdAt: '2026-10-08T00:00:00.000Z',
}

describe('notificationText (S4a §5: web renders from kind + params)', () => {
  test('renders a known kind from the locale with its params', () => {
    expect(notificationText(base, enI18n())).toBe('Ann assigned you KODA-1: Fix login')
  })

  test.each([
    ['ticket_mentioned', { ref: 'KODA-2', ticketTitle: 'x', actorName: 'Bo' }, 'Bo mentioned you on KODA-2'],
    ['ticket_commented', { ref: 'KODA-3', ticketTitle: 'x', actorName: 'Cy' }, 'Cy commented on KODA-3'],
    ['ticket_status_changed', { ref: 'KODA-4', ticketTitle: 'x', actorName: 'Di', fromStatus: 'CREATED', newStatus: 'VERIFIED' }, 'KODA-4 moved CREATED → VERIFIED'],
    ['job_escalated', { repo: 'acme/app', feature: 'f', state: 'ESCALATED' }, 'Fleet job on acme/app escalated'],
    ['job_pr_opened', { repo: 'acme/app', feature: 'f', prUrl: 'https://x' }, 'Fleet job on acme/app opened a PR'],
    ['approval_requested', { repo: 'acme/app', kind: 'bash' }, 'Approval needed: bash on acme/app'],
    ['budget_hard_stop', { scope: 'acme/app', spentUsd: '12.00', amountUsd: '10.00' }, 'Budget acme/app stopped at 12.00 of 10.00 USD'],
    ['runner_offline', { runner: 'wk-mac' }, 'Runner wk-mac is offline'],
    ['credential_expiring', { runner: 'wk-mac', provider: 'openai-codex', expiresAt: '2026-10-11' }, 'openai-codex credential on wk-mac expires 2026-10-11'],
  ])('%s', (kind, params, expected) => {
    expect(notificationText({ ...base, kind, params }, enI18n())).toBe(expected)
  })

  test('an unknown kind falls back to the API title', () => {
    expect(notificationText({ ...base, kind: 'from_the_future', title: 'Server text' }, enI18n())).toBe('Server text')
  })
})

describe('isInAppPath', () => {
  test.each([
    ['/koda/tickets/KODA-1', true],
    ['/admin/fleet/approvals', true],
    ['//evil.example/x', false],
    ['https://evil.example', false],
    ['javascript:alert(1)', false],
    ['', false],
    [null, false],
  ])('%s -> %s', (link, expected) => {
    expect(isInAppPath(link)).toBe(expected)
  })
})

describe('categories', () => {
  test('exactly the five spec categories, in display order', () => {
    expect(NOTIFICATION_CATEGORIES).toEqual(['ASSIGNED', 'MENTIONED', 'WATCHED_ACTIVITY', 'FLEET_NEEDS_YOU', 'FLEET_HEALTH'])
  })
})
