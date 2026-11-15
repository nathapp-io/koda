import { test, expect } from '@playwright/test'
import type { Page } from '@playwright/test'
import { waitForHydration } from './fixtures/page-helpers'
import { readAuthFixture, useChineseLocale, webUrl } from './fixtures/password-journeys'

/**
 * koda #466: the `/reset-password/[token]` journey.
 *
 * Every journey gets its own account (and its own token) because a confirmation spends its token
 * and discards the account's other outstanding links: a shared account would let one journey
 * change the answer another one sees.
 */
const NEW_PASSWORD = 'NewE2ePassword1!'

/** Fills the reset form and submits it. */
async function submitReset(page: Page, token: string, password: string): Promise<void> {
  await page.goto(`${webUrl()}/reset-password/${token}`)
  await waitForHydration(page)
  await page.locator('#newPassword').fill(password)
  await page.locator('#confirmNewPassword').fill(password)
  await page.getByRole('button', { name: 'Reset password' }).click()
}

test.describe('the reset-password journey', () => {
  // A reset token is single-use: a retry would find it spent and would prove nothing.
  test.describe.configure({ retries: 0 })

  test('a valid token sets the password and signs nobody in', async ({ page }) => {
    const fixture = readAuthFixture()

    await submitReset(page, fixture.accounts.valid.resetToken, NEW_PASSWORD)

    // The password is set and the user is sent to the sign-in page with the notice.
    await expect(page).toHaveURL(`${webUrl()}/login?reset=1`)
    await expect(page.getByText('Your password has been changed')).toBeVisible()

    // The confirmation changes the password and issues no session.
    const cookies = await page.context().cookies()
    expect(cookies.find((cookie) => cookie.name === 'koda_token')).toBeUndefined()
    expect(cookies.find((cookie) => cookie.name === 'koda_refresh')).toBeUndefined()
  })

  test('a token that was already used shows the invalid-link state', async ({ page }) => {
    const fixture = readAuthFixture()
    const token = fixture.accounts.replayable.resetToken

    // Spend the token: the confirmation marks it used.
    await submitReset(page, token, NEW_PASSWORD)
    await expect(page).toHaveURL(`${webUrl()}/login?reset=1`)

    // The same link again: dead.
    await submitReset(page, token, NEW_PASSWORD)
    await expect(page.getByRole('alert')).toContainText('This link is invalid or has expired')
    await expect(page.getByRole('link', { name: 'Request a new link' })).toHaveAttribute(
      'href',
      '/forgot-password',
    )
  })

  test('an expired token shows the invalid-link state', async ({ page }) => {
    const fixture = readAuthFixture()

    await submitReset(page, fixture.accounts.expired.resetToken, NEW_PASSWORD)

    await expect(page.getByRole('alert')).toContainText('This link is invalid or has expired')
    await expect(page.getByRole('link', { name: 'Request a new link' })).toHaveAttribute(
      'href',
      '/forgot-password',
    )
  })

  test('a password the API refuses keeps the form and names the field', async ({ page }) => {
    const fixture = readAuthFixture()

    // The API refuses this password before it touches the token, so the link stays usable.
    await submitReset(page, fixture.accounts.weak.resetToken, 'weakpassword')

    await expect(page.locator('form p', { hasText: 'uppercase' })).toBeVisible()
    // A refused password is not a dead link: the form stays and the invalid-link state never shows.
    await expect(page.locator('form')).toBeVisible()
    await expect(page.getByRole('alert')).toHaveCount(0)
  })

  test('a signed-in user is sent away from the reset page', async ({ page }) => {
    const fixture = readAuthFixture()
    // The account whose password no journey changes.
    const account = fixture.accounts.expired

    await page.goto(`${webUrl()}/login`)
    await waitForHydration(page)
    await page.locator('input[type="email"]').fill(account.email)
    await page.locator('input[type="password"]').fill(account.password)
    await page.getByRole('button', { name: 'Sign in' }).click()
    await expect(page).not.toHaveURL(/\/login/)

    await page.goto(`${webUrl()}/reset-password/${account.resetToken}`)
    await waitForHydration(page)

    // The reset page is for guests: a signed-in browser is redirected away from it.
    await expect(page).not.toHaveURL(/\/reset-password/)
  })

  test('the page renders in Chinese', async ({ page }) => {
    const fixture = readAuthFixture()

    await useChineseLocale(page)
    await page.goto(`${webUrl()}/reset-password/${fixture.accounts.expired.resetToken}`)
    await waitForHydration(page)

    await expect(page.getByRole('heading', { name: '重置密码' })).toBeVisible()
    await page.locator('#newPassword').fill(NEW_PASSWORD)
    await page.locator('#confirmNewPassword').fill(NEW_PASSWORD)
    await page.getByRole('button', { name: '重置密码' }).click()

    await expect(page.getByRole('alert')).toContainText('此链接无效或已过期')
  })
})
