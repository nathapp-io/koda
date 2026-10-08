import { describe, expect, test } from '@jest/globals'
import { readFileSync } from 'fs'
import { join } from 'path'

const source = readFileSync(join(__dirname, '../../layouts/default.vue'), 'utf-8')

describe('S4a §5: the header carries the notification bell', () => {
  test('signed-in users get the bell, before the fleet approval badge', () => {
    const bell = source.indexOf('<NotificationBell v-if="auth.user.value" />')
    const badge = source.indexOf('<FleetApprovalBadge')
    expect(bell).toBeGreaterThan(-1)
    expect(bell).toBeLessThan(badge)
  })
})
