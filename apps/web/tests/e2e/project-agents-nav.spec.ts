import { test, expect } from '@playwright/test'
import { login, createProject, deleteProject, E2E_ADMIN } from './fixtures/api-client'
import { webLogin, generateUniqueProjectKey, waitForHydration } from './fixtures/page-helpers'

test.describe('Project agents nav (issue #252)', () => {
  let token: string
  let slug: string

  test.beforeAll(async () => {
    ({ token } = await login(E2E_ADMIN.email, E2E_ADMIN.password))
    const proj = await createProject(token, {
      name: 'E2E Project Agents Nav',
      slug: `e2e-project-agents-${Date.now()}`,
      key: generateUniqueProjectKey('PA'),
    })
    slug = proj.slug
  })

  test.afterAll(async () => {
    if (slug) await deleteProject(token, slug)
  })

  test('the sidebar project block links to the project roster from a project page', async ({ page }) => {
    await webLogin(page)
    await page.goto(`/${slug}`)
    await waitForHydration(page)

    const aside = page.getByRole('complementary', { name: 'Primary' })
    await expect(aside.locator(`a[href="/${slug}/agents"]`)).toBeVisible()
    await aside.locator(`a[href="/${slug}/agents"]`).click()
    await expect(page).toHaveURL(new RegExp(`/${slug}/agents$`))
  })

  test('the roster link is active on the roster page and the global link is not', async ({ page }) => {
    await webLogin(page)
    await page.goto(`/${slug}/agents`)
    await waitForHydration(page)

    const aside = page.getByRole('complementary', { name: 'Primary' })
    await expect(aside.locator(`a[href="/${slug}/agents"]`)).toHaveClass(/bg-accent/)
    await expect(aside.locator('a[href="/agents"]')).not.toHaveClass(/bg-accent/)
  })

  test('the roster page breadcrumb reads Koda > project > Agents', async ({ page }) => {
    await webLogin(page)
    await page.goto(`/${slug}/agents`)
    await waitForHydration(page)

    const breadcrumb = page.locator('nav', { hasText: 'Koda' })
    await expect(breadcrumb.getByRole('link', { name: slug })).toBeVisible()
    await expect(breadcrumb.locator('span.font-medium')).toHaveText('Agents')
  })
})
