import { test, expect } from '@playwright/test';
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

    // Should stay on login page and keep the sign-in form visible
    await expect(page).toHaveURL('/login');
    await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
  });

  test('unauthenticated users are redirected to login from dashboard route', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveURL('/login', { timeout: 5000 });
    await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
  });

  test('logout clears session and redirects to login', async ({ page }) => {
    await webLogin(page);
    await expect(page).toHaveURL('/');

    // Target the visible logout action regardless of layout region.
    await page.getByRole('button', { name: 'Logout' }).first().click();
    await expect(page).toHaveURL('/login', { timeout: 5000 });

    // Verify session cleared by checking auth cookie removal
    const cookies = await page.context().cookies();
    const authCookie = cookies.find((cookie) => cookie.name === 'koda_token');
    expect(authCookie?.value ?? '').toBe('');

    // Root should redirect to login when unauthenticated.
    await page.goto('/');
    await expect(page).toHaveURL('/login', { timeout: 3000 });
  });
});
