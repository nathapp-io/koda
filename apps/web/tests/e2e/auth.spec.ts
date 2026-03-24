import { test, expect } from '@playwright/test';
import { E2E_ADMIN } from './fixtures/api-client';
import { webLogin } from './fixtures/page-helpers';

test.describe('Authentication', () => {
  test('login page is accessible', async ({ page }) => {
    await page.goto('/login');
    await expect(page).toHaveURL('/login');
    await expect(page.locator('input[type="email"]')).toBeVisible();
    await expect(page.locator('input[type="password"]')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
  });

  test('successful login redirects to dashboard', async ({ page }) => {
    await webLogin(page);
    await expect(page).toHaveURL('/');
  });

  test('invalid credentials shows error', async ({ page }) => {
    await page.goto('/login');
    await page.locator('input[type="email"]').fill('wrong@example.com');
    await page.locator('input[type="password"]').fill('wrongpassword');
    await page.getByRole('button', { name: 'Sign in' }).click();

    // Should stay on login page
    await expect(page).toHaveURL('/login');
    // Error toast or form validation message
    await expect(
      page.locator('[data-sonner-toast], .text-destructive, [role="alert"]').first(),
    ).toBeVisible({ timeout: 4000 });
  });

  test('protected routes redirect unauthenticated users to login', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveURL('/login', { timeout: 5000 });
  });

  test('logout clears session and redirects to login', async ({ page }) => {
    await webLogin(page);
    await expect(page).toHaveURL('/');

    // Logout button is in the sidebar
    await page.getByRole('button', { name: 'Logout' }).click();
    await expect(page).toHaveURL('/login', { timeout: 5000 });

    // Verify session cleared — navigating to / should redirect again
    await page.goto('/');
    await expect(page).toHaveURL('/login', { timeout: 3000 });
  });
});
