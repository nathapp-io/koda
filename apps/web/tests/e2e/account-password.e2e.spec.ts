import { test, expect } from '@playwright/test'
import { randomBytes } from 'node:crypto'
import { createUser, login, E2E_ADMIN } from './fixtures/api-client'
import { waitForHydration, webLogin } from './fixtures/page-helpers'
import { tryLogin, useChineseLocale, webUrl } from './fixtures/password-journeys'

/**
 * koda #466: the `/settings/account` journey.
 *
 * The account belongs to this spec and is never the seeded admin: every e2e spec logs in as the
 * admin, and the e2e database is reset only at the start of a run, so a journey that changed the
 * admin's password would break every spec that runs after it.
 */
const NEW_PASSWORD = 'NewE2ePassword1!'

test.describe('the account password journey', () => {
  const password = 'E2ePassword1!'
  let email: string

  test.beforeEach(async () => {
    // A fresh account per attempt: the journey changes the password, so a retry must not start from
    // the password the previous attempt left behind.
    email = `account-password-${randomBytes(4).toString('hex')}@koda-e2e.test`
    const token = (await login(E2E_ADMIN.email, E2E_ADMIN.password)).token
    await createUser(token, { email, name: 'Account Password E2E', password })
  })

  test('a wrong current password is a field error, not a generic error', async ({ page }) => {
    await webLogin(page, email, password)
    await page.goto(`${webUrl()}/settings/account`)
    await waitForHydration(page)

    await page.locator('#currentPassword').fill('WrongPassword1!')
    await page.locator('#newPassword').fill(NEW_PASSWORD)
    await page.locator('#confirmNewPassword').fill(NEW_PASSWORD)
    await page.getByRole('button', { name: 'Change password' }).click()

    // The API answers 403 with the ret code 40003; the page turns that into the field-level message.
    await expect(page.locator('#currentPassword-error')).toHaveText('Current password is incorrect')
    // ...and not into a toast.
    await expect(page.locator('[data-sonner-toast]')).toHaveCount(0)
  })

  test('the new password works and the old one does not', async ({ page }) => {
    await webLogin(page, email, password)
    await page.goto(`${webUrl()}/settings/account`)
    await waitForHydration(page)

    await page.locator('#currentPassword').fill(password)
    await page.locator('#newPassword').fill(NEW_PASSWORD)
    await page.locator('#confirmNewPassword').fill(NEW_PASSWORD)
    await page.getByRole('button', { name: 'Change password' }).click()

    await expect(page.locator('[data-sonner-toast]')).toContainText('Password changed')

    // The old password is refused and the new one works.
    expect((await tryLogin(email, password)).ok).toBe(false)
    expect((await tryLogin(email, NEW_PASSWORD)).ok).toBe(true)
  })

  test('the page renders in Chinese', async ({ page }) => {
    await useChineseLocale(page)
    await webLogin(page, email, password)
    await page.goto(`${webUrl()}/settings/account`)
    await waitForHydration(page)

    await expect(page.getByRole('heading', { name: '修改密码' })).toBeVisible()
    await expect(page.getByLabel('当前密码')).toBeVisible()
  })
})
