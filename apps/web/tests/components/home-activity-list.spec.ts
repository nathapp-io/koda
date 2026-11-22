import { describe, test, expect } from '@jest/globals'
import { computed, ref } from 'vue'
import { mountSfc, webFile } from '../helpers/mount-sfc'
import { uiStubs, enI18n } from '../helpers/fleet-harness'
import type { HomeActivity } from '../../lib/home-types'

const activityList = webFile('components', 'home', 'HomeActivityList.vue')

const NOW = new Date('2026-10-06T12:00:00Z')

const event = (over: Partial<HomeActivity> = {}): HomeActivity => ({
  id: 'e1', eventType: 'ticket_event', projectSlug: 'acme', action: 'STATUS_CHANGE',
  actorId: 'u1', actorName: 'Alice', ticketId: 't1', ticketRef: 'ACME-12', ticketTitle: 'Fix login',
  createdAt: '2026-10-06T11:00:00Z', ...over,
})

function mount(activity: HomeActivity[]) {
  return mountSfc(activityList, {
    components: { ...uiStubs },
    props: { activity, now: NOW },
    globals: { ref, computed, useI18n: () => enI18n() },
  })
}

describe('HomeActivityList', () => {
  test('words the event type, words the action code (raw code kept as a tooltip) and shows the project', () => {
    const app = mount([
      event(),
      event({ id: 'e2', eventType: 'agent_event', action: 'CODE_INDEXED', ticketId: null }),
      event({ id: 'e3', eventType: 'decision_event', action: 'decided', ticketId: null }),
    ])
    const text = app.text()
    expect(text).toContain('Ticket')
    expect(text).toContain('Agent')
    expect(text).toContain('Decision')
    expect(text).toContain('Status change')
    expect(text).not.toContain('STATUS_CHANGE')
    expect(app.find('[title="STATUS_CHANGE"]')).toHaveLength(1)
    expect(text).toContain('acme')
    expect(app.find('[data-testid="home-activity-decision_event"]')).toHaveLength(1)
    app.unmount()
  })

  test('AC-1: renders the API actor name', () => {
    const app = mount([event()])
    expect(app.textOf(app.one('[data-testid="home-activity-actor"]'))).toBe('Alice')
    app.unmount()
  })

  test('AC-2: renders a ticket link with its project path and title', () => {
    const app = mount([event()])
    const link = app.one('[data-testid="home-activity-ticket"]')
    expect(link?.props.to).toBe('/acme/tickets/ACME-12')
    expect(app.textOf(link)).toBe('ACME-12 Fix login')
    app.unmount()
  })

  test('AC-3: renders only the ticket ref when its title is null', () => {
    const app = mount([event({ ticketTitle: null })])
    const link = app.one('[data-testid="home-activity-ticket"]')
    expect(app.textOf(link)).toBe('ACME-12')
    app.unmount()
  })

  test('AC-4: does not link an activity event without a ticket', () => {
    const app = mount([event({ eventType: 'agent_event', ticketRef: null, ticketTitle: null })])
    expect(app.find('[data-testid="home-activity-ticket"]')).toHaveLength(0)
    app.unmount()
  })

  test('AC-5: uses Former member when the API actor name is null', () => {
    const app = mount([event({ actorName: null })])
    expect(app.textOf(app.one('[data-testid="home-activity-actor"]'))).toBe('Former member')
    app.unmount()
  })

  test('an empty feed reads as one quiet line', () => {
    const app = mount([])
    expect(app.text()).toContain('No recent activity')
    app.unmount()
  })
})
