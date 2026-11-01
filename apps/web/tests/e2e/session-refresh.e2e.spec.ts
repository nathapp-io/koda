import { test, expect } from '@playwright/test'
import { waitForHydration, webLogin } from './fixtures/page-helpers'

test('SSR refresh restores /projects after only the access cookie is deleted', async ({ page }) => {
  await webLogin(page)
  const webUrl = process.env['E2E_WEB_URL'] ?? 'http://localhost:3103'
  const cookies = await page.context().cookies()
  const refreshCookie = cookies.find((cookie) => cookie.name === 'koda_refresh')
  expect(refreshCookie?.value ?? '').not.toBe('')

  await page.goto('/projects')
  await page.context().clearCookies({ name: 'koda_token' })
  await page.reload()
  await waitForHydration(page)

  await expect(page).toHaveURL(/\/projects$/)
  await expect(page).not.toHaveURL(/\/login/)
  const restored = await page.context().cookies(webUrl)
  expect(restored.find((cookie) => cookie.name === 'koda_token')?.value ?? '').not.toBe('')
})
