import { test, expect } from '@playwright/test'
import {
  login, createProject, createTicket, deleteTicket, deleteProject, E2E_ADMIN,
} from './fixtures/api-client'
import { webLogin, generateUniqueProjectKey, waitForHydration } from './fixtures/page-helpers'

test.describe('Board filter', () => {
  let token: string
  let slug: string
  const refs: string[] = []

  test.beforeAll(async () => {
    ({ token } = await login(E2E_ADMIN.email, E2E_ADMIN.password))
    const proj = await createProject(token, {
      name: 'E2E Filter Project',
      slug: `e2e-filter-${Date.now()}`,
      key: generateUniqueProjectKey('FT'),
    })
    slug = proj.slug
    const a = await createTicket(token, slug, {
      title: 'Payment webhook fails on timeout',
      type: 'BUG',
      priority: 'CRITICAL',
    })
    const b = await createTicket(token, slug, {
      title: 'Add retry knob to importer',
      type: 'ENHANCEMENT',
      priority: 'LOW',
    })
    refs.push(a.ref, b.ref)
  })

  test.afterAll(async () => {
    for (const ref of refs) await deleteTicket(token, slug, ref).catch(() => {})
    if (slug) await deleteProject(token, slug)
  })

  test('text search narrows cards and announces the count', async ({ page }) => {
    await webLogin(page)
    await page.goto(`/${slug}`)
    await waitForHydration(page)
    const card = (title: RegExp) => page.getByRole('button', { name: title })

    await expect(card(/Payment webhook/i)).toBeVisible()
    await expect(card(/retry knob/i)).toBeVisible()

    await page.getByLabel('Filter by ref or title…').fill('webhook')
    await expect(card(/Payment webhook/i)).toBeVisible()
    await expect(card(/retry knob/i)).toBeHidden()
    await expect(page.getByText('Showing 1 of 2')).toBeVisible()

    await page.getByRole('button', { name: 'Clear filters' }).click()
    await expect(card(/retry knob/i)).toBeVisible()
  })

  test('priority chip filters by priority and toggles off', async ({ page }) => {
    await webLogin(page)
    await page.goto(`/${slug}`)
    await waitForHydration(page)
    const card = (title: RegExp) => page.getByRole('button', { name: title })

    await page.getByRole('group', { name: 'Priority' }).getByRole('button', { name: 'Critical' }).click()
    await expect(card(/Payment webhook/i)).toBeVisible()
    await expect(card(/retry knob/i)).toBeHidden()
    await expect(page.getByText('Showing 1 of 2')).toBeVisible()

    await page.getByRole('group', { name: 'Priority' }).getByRole('button', { name: 'Critical' }).click()
    await expect(card(/retry knob/i)).toBeVisible()
  })
})
