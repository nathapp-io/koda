import { test, expect } from '@playwright/test';
import { E2E_ADMIN } from './fixtures/api-client';

test.describe('Authentication', () => {
  test('login page is accessible', async ({ page }) => {
    await page.goto('/login');
    await expect(page).toHaveURL('/login');
    await expect(page.getByPlaceholder(/email/i)).toBeVisible();
    await expect(page.getByPlaceholder(/password/i)).toBeVisible();
    await expect(page.getByRole('button', { name: /login|sign in/i })).toBeVisible();
  });

  test('successful login redirects to dashboard', async ({ page }) => {
    await page.goto('/login');
    await page.getByPlaceholder(/email/i).fill(E2E_ADMIN.email);
    await page.getByPlaceholder(/password/i).fill(E2E_ADMIN.password);
    await page.getByRole('button', { name: /login|sign in/i }).click();

    await expect(page).not.toHaveURL('/login', { timeout: 5000 });
    await expect(page).toHaveURL('/');
  });

  test('invalid credentials shows error', async ({ page }) => {
    await page.goto('/login');
    await page.getByPlaceholder(/email/i).fill('wrong@example.com');
    await page.getByPlaceholder(/password/i).fill('wrongpassword');
    await page.getByRole('button', { name: /login|sign in/i }).click();

    // Should stay on login page and show error
    await expect(page).toHaveURL('/login');
    // Error toast or form error should appear
    await expect(page.locator('[role="alert"], .text-destructive, [data-sonner-toast]')).toBeVisible({ timeout: 3000 });
  });

  test('protected routes redirect unauthenticated users to login', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveURL('/login', { timeout: 5000 });
  });

  test('logout clears session and redirects to login', async ({ page }) => {
    // Login first
    await page.goto('/login');
    await page.getByPlaceholder(/email/i).fill(E2E_ADMIN.email);
    await page.getByPlaceholder(/password/i).fill(E2E_ADMIN.password);
    await page.getByRole('button', { name: /login|sign in/i }).click();
    await expect(page).toHaveURL('/');

    // Find and click logout
    await page.getByRole('button', { name: /logout|sign out/i }).click();
    await expect(page).toHaveURL('/login', { timeout: 5000 });

    // Verify session is cleared — navigating to / should redirect
    await page.goto('/');
    await expect(page).toHaveURL('/login', { timeout: 3000 });
  });
});
