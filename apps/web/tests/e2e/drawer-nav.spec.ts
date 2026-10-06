import { test, expect } from '@playwright/test'
import { login, createProject, deleteProject, E2E_ADMIN } from './fixtures/api-client'
import { webLogin, generateUniqueProjectKey } from './fixtures/page-helpers'

test.describe('Drawer navigation (mobile, <1024px)', () => {
  test.use({ viewport: { width: 375, height: 812 } })

  let token: string
  let slug: string

  test.beforeAll(async () => {
    ({ token } = await login(E2E_ADMIN.email, E2E_ADMIN.password))
    const proj = await createProject(token, {
      name: 'E2E Drawer Project',
      slug: `e2e-drawer-${Date.now()}`,
      key: generateUniqueProjectKey('DR'),
    })
    slug = proj.slug
  })

  test.afterAll(async () => {
    if (slug) await deleteProject(token, slug)
  })

  test('drawer starts closed, opens via toggle, closes on Escape with focus restored', async ({ page }) => {
    await webLogin(page)
    const aside = page.getByRole('complementary', { name: 'Primary' })
    const toggle = page.getByRole('button', { name: 'Toggle sidebar' })

    await expect(aside).toBeHidden()
    await toggle.click()
    await expect(aside).toBeVisible()
    await expect(toggle).toHaveAttribute('aria-expanded', 'true')
    await expect(toggle).toHaveAttribute('aria-controls', 'primary-nav')

    await page.keyboard.press('Escape')
    await expect(aside).toBeHidden()
    await expect(toggle).toBeFocused()
  })

  test('navigating from the drawer closes it', async ({ page }) => {
    await webLogin(page)
    await page.goto(`/${slug}`)
    const aside = page.getByRole('complementary', { name: 'Primary' })
    await page.getByRole('button', { name: 'Toggle sidebar' }).click()
    await expect(aside).toBeVisible()
    await aside.getByRole('link', { name: 'Knowledge Base' }).click()
    await expect(page).toHaveURL(new RegExp(`/${slug}/kb`))
    await expect(aside).toBeHidden()
  })

  test('skip link is the first tab stop and jumps to main', async ({ page }) => {
    await webLogin(page)
    await page.keyboard.press('Tab')
    await expect(page.getByRole('link', { name: 'Skip to content' })).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(page.locator('main#main')).toBeFocused()
  })
})
