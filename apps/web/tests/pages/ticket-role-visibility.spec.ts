import { describe, test, expect } from '@jest/globals'
import { readFileSync } from 'fs'
import { join } from 'path'

const webDir = join(__dirname, '../..')
const read = (...p: string[]) => readFileSync(join(webDir, ...p), 'utf-8')

describe('#144 ticket page visibility follows the project role', () => {
  // 2026-10-05 UX redesign slice 1: role-gated mutations (assign, labels,
  // links, delete) moved into components/TicketProperties.vue, so the
  // role assertions read the page plus that component.
  const page = () => [
    read('pages', '[project]', 'tickets', '[ref].vue'),
    read('components', 'TicketProperties.vue'),
  ].join('\n')

  test('loads the caller project role via the SSR-friendly useProjectViewerRole composable', () => {
    // #144 + BUG-4: viewerRole must be populated on SSR (useAsyncData) so
    // the controls are present on first paint — no flash of "no controls"
    // after hydration.
    expect(page()).toContain('useProjectViewerRole(')
    expect(page()).toContain('viewerRole')
  })

  test('assign and label controls need DEVELOPER or ADMIN, not the global role', () => {
    expect(page()).not.toContain("currentUser.value?.role === 'ADMIN'")
    expect(page()).toMatch(/const canWork = computed/)
  })

  test('delete ticket is shown only to a project/global ADMIN', () => {
    expect(page()).toMatch(/v-if="canManage"[\s\S]{0,200}deleteTicket/)
  })

  test('assignee type carries kind and id', () => {
    expect(page()).toMatch(/kind:\s*'user'\s*\|\s*'agent'/)
  })
})

describe('#144 labels page visibility', () => {
  const page = () => read('pages', '[project]', 'labels.vue')

  test('edit and delete are shown only to a project/global ADMIN', () => {
    expect(page()).toMatch(/v-if="canManage"[\s\S]{0,400}deleteLabel/)
  })

  test('the create form is hidden from a VIEWER', () => {
    expect(page()).toMatch(/v-if="canCreate"/)
  })
})
