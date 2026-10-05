import { describe, test, expect } from '@jest/globals'
import { computed, ref } from 'vue'
import { mountSfc, webFile } from '../helpers/mount-sfc'
import { uiStubs, enI18n } from '../helpers/fleet-harness'
import type { HomeActivity } from '../../lib/home-types'

const activityList = webFile('components', 'home', 'HomeActivityList.vue')

const NOW = new Date('2026-10-06T12:00:00Z')

const event = (over: Partial<HomeActivity> = {}): HomeActivity => ({
  id: 'e1', eventType: 'ticket_event', projectSlug: 'acme', action: 'STATUS_CHANGE',
  actorId: 'u1', ticketId: 't1', createdAt: '2026-10-06T11:00:00Z', ...over,
})

function mount(activity: HomeActivity[]) {
  return mountSfc(activityList, {
    components: uiStubs,
    props: { activity, now: NOW },
    globals: { ref, computed, useI18n: () => enI18n() },
  })
}

describe('HomeActivityList', () => {
  test('words the event type and shows the raw action code and project', () => {
    const app = mount([
      event(),
      event({ id: 'e2', eventType: 'agent_event', action: 'CODE_INDEXED', ticketId: null }),
      event({ id: 'e3', eventType: 'decision_event', action: 'decided', ticketId: null }),
    ])
    const text = app.text()
    expect(text).toContain('Ticket')
    expect(text).toContain('Agent')
    expect(text).toContain('Decision')
    expect(text).toContain('STATUS_CHANGE')
    expect(text).toContain('acme')
    expect(app.find('[data-testid="home-activity-decision_event"]')).toHaveLength(1)
    app.unmount()
  })

  test('an empty feed reads as one quiet line', () => {
    const app = mount([])
    expect(app.text()).toContain('No recent activity')
    app.unmount()
  })
})
