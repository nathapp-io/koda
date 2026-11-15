import { test, expect } from '@playwright/test'
import type { Page } from '@playwright/test'
import { E2E_ADMIN } from './fixtures/api-client'
import { waitForHydration } from './fixtures/page-helpers'
import { useChineseLocale, webUrl } from './fixtures/password-journeys'

/**
 * koda #466: the `/forgot-password` journey.
 *
 * `POST /auth/password-reset` answers 200 for every address — a known one, an unknown one, a
 * disabled account, an installation without email — so the non-enumeration is the API's promise.
 * The journey's job is to show the same page for a known and an unknown address.
 */

/** Fills the form, submits it and returns the text of the check-email state. */
async function requestReset(page: Page, email: string, submitLabel = 'Send reset link'): Promise<string> {
  await page.goto(`${webUrl()}/forgot-password`)
  await waitForHydration(page)
  await page.locator('#email').fill(email)
  await page.getByRole('button', { name: submitLabel }).click()
  const status = page.locator('[role="status"]')
  await expect(status).toBeVisible()
  return (await status.textContent()) ?? ''
}

test.describe('the forgot-password journey', () => {
  test('a guest reaches the page instead of the login', async ({ page }) => {
    await page.goto(`${webUrl()}/forgot-password`)
    await waitForHydration(page)

    await expect(page).toHaveURL(`${webUrl()}/forgot-password`)
    await expect(page.getByRole('heading', { name: 'Forgot password?' })).toBeVisible()
  })

  test('a known and an unknown address show the identical state', async ({ page }) => {
    const statuses: number[] = []
    page.on('response', (response) => {
      if (response.url().endsWith('/api/auth/password-reset')) statuses.push(response.status())
    })

    const known = await requestReset(page, E2E_ADMIN.email)
    const unknown = await requestReset(page, 'nobody-at-all@koda-e2e.test')

    expect(known).toBe(unknown)
    expect(known).toContain('check your inbox')
    // The API answers the same way for both, too.
    expect(statuses).toEqual([200, 200])
  })

  test('the page renders in Chinese', async ({ page }) => {
    await useChineseLocale(page)
    const text = await requestReset(page, 'nobody-at-all@koda-e2e.test', '发送重置链接')
    expect(text).toContain('请查看收件箱中的重置链接')
  })
})
