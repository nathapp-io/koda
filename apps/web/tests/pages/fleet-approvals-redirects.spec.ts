import { describe, expect, jest, test } from '@jest/globals'
import { mountSfc, webFile } from '../helpers/mount-sfc'

/**
 * US-010 AC-1/AC-2/AC-3: the two retired fleet inboxes are redirect pages now. The engine inbox at `/approvals`
 * replaced them, but fleet notifications keep linking to `/admin/fleet/approvals` until 7c, so the redirect keeps the
 * query (a notification's `?id=`) and is temporary (302): a cached 301 would outlive that link.
 *
 * The redirect pages run their real `<script setup>` through the harness, with `navigateTo` doubled, so these
 * assertions are on the exact call the page makes — not on the page's source text.
 */
const adminPage = webFile('pages', 'admin', 'fleet', 'approvals.vue')
const projectPage = webFile('pages', '[project]', 'fleet', 'approvals.vue')

interface RouteDouble {
  params?: Record<string, string>
  query?: Record<string, string | string[]>
}

/** Mounts one redirect page for a route and returns the `navigateTo` calls it made on setup. */
function mount(file: string, route: RouteDouble = {}): { calls: unknown[][] } {
  const navigateTo = jest.fn()
  const app = mountSfc(file, {
    globals: {
      navigateTo,
      useRoute: () => ({ params: route.params ?? {}, query: route.query ?? {} }),
    },
  })
  app.unmount()
  return { calls: navigateTo.mock.calls as unknown[][] }
}

describe('US-010 AC-1: /admin/fleet/approvals?id=r1 redirects to /approvals?id=r1 with 302', () => {
  test('AC-1: the id survives the redirect and the code is temporary', () => {
    const { calls } = mount(adminPage, { query: { id: 'r1' } })

    expect(calls).toEqual([[{ path: '/approvals', query: { id: 'r1' } }, { redirectCode: 302 }]])
  })

  test('AC-1: the whole query survives, not just the id', () => {
    const { calls } = mount(adminPage, { query: { id: 'r1', tab: 'all' } })

    expect(calls).toEqual([[{ path: '/approvals', query: { id: 'r1', tab: 'all' } }, { redirectCode: 302 }]])
  })
})

describe('US-010 AC-2: /admin/fleet/approvals with no query redirects to /approvals', () => {
  test('AC-2: the target carries no query and the code is still 302', () => {
    const { calls } = mount(adminPage)

    expect(calls).toEqual([[{ path: '/approvals', query: {} }, { redirectCode: 302 }]])
  })
})

describe('US-010 AC-3: /sandbox/fleet/approvals?id=r1 redirects to /sandbox/approvals?id=r1 with 302', () => {
  test('AC-3: the project slug and the id both survive, and the code is temporary', () => {
    const { calls } = mount(projectPage, { params: { project: 'sandbox' }, query: { id: 'r1' } })

    expect(calls).toEqual([[{ path: '/sandbox/approvals', query: { id: 'r1' } }, { redirectCode: 302 }]])
  })

  test('AC-3: a project URL without a query redirects to its own approvals page', () => {
    const { calls } = mount(projectPage, { params: { project: 'sandbox' } })

    expect(calls).toEqual([[{ path: '/sandbox/approvals', query: {} }, { redirectCode: 302 }]])
  })
})
