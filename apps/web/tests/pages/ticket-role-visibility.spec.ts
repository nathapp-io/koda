import { describe, test, expect } from '@jest/globals'
import { readFileSync } from 'fs'
import { join } from 'path'

const webDir = join(__dirname, '../..')
const read = (...p: string[]) => readFileSync(join(webDir, ...p), 'utf-8')

/**
 * #144 shipped a role-based ticket gate; Permissions P1 US-007 replaced it with one flag per
 * permission key. The behavioural ACs live in
 * `tests/pages/project-permission-gates.spec.ts` (they mount the real page with
 * `GET /me/permissions` answering the keys); this spec keeps the cheap structural assertions that
 * the role booleans are gone for good.
 */
describe('#144 → US-007 ticket page visibility follows the permission keys', () => {
  // 2026-10-05 UX redesign slice 1: role-gated mutations (assign, labels,
  // links, delete) moved into components/TicketProperties.vue, so the
  // role assertions read the page plus that component.
  const page = () => [
    read('pages', '[project]', 'tickets', '[ref].vue'),
    read('components', 'TicketProperties.vue'),
  ].join('\n')

  test('loads the caller project keys through the SSR-friendly useProjectPermissions composable', () => {
    // #144 + BUG-4: the gates must be populated on SSR (useAsyncData) so
    // the controls are present on first paint — no flash of "no controls"
    // after hydration.
    expect(page()).toContain('useProjectPermissions(')
    expect(page()).not.toContain('useProjectViewerRole(')
  })

  test('assign and label controls follow their own keys, not a role boolean', () => {
    expect(page()).not.toContain("currentUser.value?.role === 'ADMIN'")
    expect(page()).not.toMatch(/const canWork = computed/)
    expect(page()).not.toMatch(/const canManage = computed/)
    expect(page()).toContain("has('ticket.assign')")
    expect(page()).toContain("has('ticket.label.assign')")
    expect(page()).toContain("has('ticket.label.remove')")
  })

  test('delete ticket follows ticket.delete', () => {
    expect(page()).toContain("has('ticket.delete')")
    expect(page()).toMatch(/v-if="canDelete"[\s\S]{0,200}deleteTicket/)
  })

  test('assignee type carries kind and id', () => {
    expect(page()).toMatch(/kind:\s*'user'\s*\|\s*'agent'/)
  })
})

describe('#144 → US-007 labels page visibility', () => {
  const page = () => read('pages', '[project]', 'labels.vue')

  test('edit and delete follow label.update and label.delete', () => {
    expect(page()).toContain("has('label.update')")
    expect(page()).toContain("has('label.delete')")
    expect(page()).toMatch(/v-if="canDelete"[\s\S]{0,200}deleteLabel/)
  })

  test('the create form follows label.create', () => {
    expect(page()).toContain("has('label.create')")
    expect(page()).toMatch(/v-if="canCreate"/)
  })
})
