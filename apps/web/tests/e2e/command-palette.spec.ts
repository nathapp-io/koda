import { test, expect } from '@playwright/test'
import { login, createProject, deleteProject, E2E_ADMIN } from './fixtures/api-client'
import { webLogin, generateUniqueProjectKey } from './fixtures/page-helpers'

test.describe('Command palette', () => {
  let token: string
  let slug: string

  test.beforeAll(async () => {
    ({ token } = await login(E2E_ADMIN.email, E2E_ADMIN.password))
    const proj = await createProject(token, {
      name: 'E2E Palette Project',
      slug: `e2e-palette-${Date.now()}`,
      key: generateUniqueProjectKey('PL'),
    })
    slug = proj.slug
  })

  test.afterAll(async () => {
    if (slug) await deleteProject(token, slug)
  })

  test('Ctrl+K opens the palette; typing filters; Enter navigates to the project', async ({ page }) => {
    await webLogin(page)
    await page.keyboard.press('Control+K')
    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible()
    const input = dialog.getByRole('combobox')
    await expect(input).toBeFocused()
    await input.fill('Palette')
    await expect(dialog.getByRole('option', { name: /Palette/ }).first()).toBeVisible()
    await page.keyboard.press('Enter')
    await expect(page).toHaveURL(new RegExp(`/${slug}$`))
    await expect(page.getByRole('dialog')).toBeHidden()
  })

  test('the project agents entry opens the project roster (issue #252)', async ({ page }) => {
    await webLogin(page)
    await page.goto(`/${slug}`)
    await page.keyboard.press('Control+K')
    const dialog = page.getByRole('dialog')
    const input = dialog.getByRole('combobox')
    await input.fill('agents')
    await expect(dialog.getByRole('option', { name: `Agents ${slug}` })).toBeVisible()
    await page.keyboard.press('Enter')
    await expect(page).toHaveURL(new RegExp(`/${slug}/agents$`))
    await expect(page.getByRole('dialog')).toBeHidden()
  })

  test('header search button opens the palette', async ({ page }) => {
    await webLogin(page)
    await page.getByRole('button', { name: 'Search or jump to…' }).click()
    await expect(page.getByRole('dialog')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog')).toBeHidden()
  })

  test('theme entry toggles the dark class', async ({ page }) => {
    await webLogin(page)
    await page.keyboard.press('Control+K')
    await page.getByRole('option', { name: 'Toggle light/dark theme' }).click()
    await expect(page.locator('html')).toHaveClass(/dark/)
    await page.keyboard.press('Control+K')
    await page.getByRole('option', { name: 'Toggle light/dark theme' }).click()
    await expect(page.locator('html')).not.toHaveClass(/dark/)
  })
})
