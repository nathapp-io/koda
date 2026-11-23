import { test, expect } from '@playwright/test'
import type { Locator } from '@playwright/test'
import {
  login, createProject, createTicket, deleteTicket, deleteProject, E2E_ADMIN,
} from './fixtures/api-client'
import { webLogin, generateUniqueProjectKey, waitForHydration } from './fixtures/page-helpers'

async function boxOf(locator: Locator): Promise<{ x: number; width: number }> {
  const box = await locator.boundingBox()
  if (!box) throw new Error('control has no bounding box')
  return box
}

// e2e-1121 polish B1: the scroll-hint overlays are absolutely positioned inside a non-scrolling
// wrapper, beside the overflow element. While they were children of the scroller they were positioned
// against its content box, so they scrolled away with the cards: after scrolling right the left
// control sat off-screen (unusable) and the right control drifted off the viewport edge. Only a real
// browser layout can measure that, hence an e2e test.
test.describe('Board scroll hints', () => {
  let token: string
  let slug: string
  let ref: string | undefined

  test.beforeAll(async () => {
    ({ token } = await login(E2E_ADMIN.email, E2E_ADMIN.password))
    const project = await createProject(token, {
      name: 'E2E Board Scroll Project',
      slug: `e2e-board-scroll-${Date.now()}`,
      key: generateUniqueProjectKey('BS'),
    })
    slug = project.slug
    const ticket = await createTicket(token, slug, {
      title: 'Board scroll hint ticket',
      type: 'BUG',
      priority: 'HIGH',
    })
    ref = ticket.ref
  })

  test.afterAll(async () => {
    if (ref) await deleteTicket(token, slug, ref).catch(() => {})
    if (slug) await deleteProject(token, slug)
  })

  test('both scroll controls stay at the viewport edges after scrolling right', async ({ page }) => {
    await webLogin(page)
    await page.goto(`/${slug}`)
    await waitForHydration(page)

    const viewport = page.viewportSize()
    if (!viewport) throw new Error('no viewport size')
    const rightButton = page.getByRole('button', { name: 'Show more columns' })
    const leftButton = page.getByRole('button', { name: 'Show earlier columns' })
    const scroller = page.getByTestId('board-scroll-container')

    // Six fixed-width columns overflow the test viewport, so the right control is offered.
    await expect(rightButton).toBeVisible()
    await expect(leftButton).toHaveCount(0)

    await rightButton.click()
    await expect.poll(() => scroller.evaluate(element => element.scrollLeft)).toBeGreaterThan(0)
    await expect(leftButton).toBeVisible()

    const left = await boxOf(leftButton)
    const right = await boxOf(rightButton)

    // The left control is reachable (it used to be clipped off-screen) and hugs the left edge.
    expect(left.x).toBeGreaterThanOrEqual(0)
    expect(left.x + left.width).toBeLessThanOrEqual(viewport.width)
    expect(left.x).toBeLessThan(viewport.width / 2)

    // The right control stays pinned to the right edge instead of drifting with the cards.
    expect(right.x).toBeGreaterThanOrEqual(0)
    expect(right.x + right.width).toBeLessThanOrEqual(viewport.width)
    expect(right.x + right.width).toBeGreaterThan(viewport.width / 2)
  })
})
