import type { Page } from '@playwright/test';
import { E2E_ADMIN } from './api-client';

/**
 * Performs login via the web UI and waits for redirect to dashboard.
 * Selectors use type attributes (not placeholders) to avoid i18n brittleness.
 */
export async function webLogin(
  page: Page,
  email = E2E_ADMIN.email,
  password = E2E_ADMIN.password,
) {
  await page.goto('/login');
  await page.locator('input[type="email"]').fill(email);
  await page.locator('input[type="password"]').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  // Wait for redirect away from /login
  await page.waitForURL((url) => !url.pathname.endsWith('/login'), { timeout: 8000 });
}

/**
 * Confirms a transition dialog (Verify, Submit Fix, Approve Fix, etc.)
 * by optionally filling a comment and clicking "Confirm".
 */
export async function confirmTransitionDialog(page: Page, comment?: string) {
  if (comment) {
    await page.getByPlaceholder(/comment|reason/i).fill(comment);
  }
  await page.getByRole('button', { name: 'Confirm' }).click();
}
