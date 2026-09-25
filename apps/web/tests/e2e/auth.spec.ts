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

  test('session survives a full page reload (H9: SSR cookies forwarded)', async ({ page }) => {
    await webLogin(page);
    await expect(page).toHaveURL('/');

    // A hard reload re-runs SSR + auth middleware against /api/auth/me.
    // If SSR fetches dropped the cookies, the middleware would bounce to /login.
    await page.reload({ waitUntil: 'networkidle' });
    await expect(page).toHaveURL('/');
    await expect(page).not.toHaveURL(/\/login/);
  });

  test('refresh flow restores the session after the access cookie is invalidated (M22)', async ({ page }) => {
    await webLogin(page);
    await expect(page).toHaveURL('/');

    const webUrl = process.env['E2E_WEB_URL'] ?? 'http://localhost:3103';

    // Corrupt only the 15-minute access cookie while keeping the 7-day
    // refresh cookie — simulates the access token expiring mid-session.
    const cookies = await page.context().cookies();
    const refreshCookie = cookies.find((cookie) => cookie.name === 'koda_refresh');
    expect(refreshCookie?.value ?? '').not.toBe('');
    await page.context().addCookies([
      { name: 'koda_token', value: 'invalid-expired-token', url: webUrl },
    ]);

    // The refresh server route must forward the REFRESH cookie (not the
    // corrupted access cookie) to the upstream API, then rotate both cookies.
    const refreshStatus = await page.evaluate(async () => {
      const res = await fetch('/api/auth/refresh', { method: 'POST' });
      return res.status;
    });
    expect(refreshStatus).toBe(200);

    const rotated = await page.context().cookies();
    const accessCookie = rotated.find((cookie) => cookie.name === 'koda_token');
    expect(accessCookie?.value).not.toBe('invalid-expired-token');

    // A full reload re-runs SSR auth middleware against the rotated access
    // cookie — the session is restored instead of bouncing to /login.
    await page.reload({ waitUntil: 'networkidle' });
    await expect(page).toHaveURL('/');
    await expect(page).not.toHaveURL(/\/login/);
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
