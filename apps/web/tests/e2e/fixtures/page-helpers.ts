import type { Page } from '@playwright/test';
import { E2E_ADMIN } from './api-client';

/**
 * Performs login by calling the API directly, then injecting the auth cookie
 * into the Playwright browser context.
 *
 * This is more reliable than UI-based login because it avoids timing issues
 * with Vue/vee-validate reactive bindings and network redirects.
 */
export async function webLogin(
  page: Page,
  email = E2E_ADMIN.email,
  password = E2E_ADMIN.password,
) {
  // 1. Call the API directly to get an access token
  const apiUrl = process.env['E2E_API_URL'] ?? 'http://localhost:3102';
  const response = await page.request.post(`${apiUrl}/api/auth/login`, {
    data: { email, password },
  });

  if (!response.ok()) {
    throw new Error(
      `Login API failed: ${response.status()} ${response.statusText()} ${await response.text()}`,
    );
  }

  const body = (await response.json()) as { ret: number; data: { accessToken: string; refreshToken: string } };
  const { accessToken, refreshToken } = body.data ?? body as unknown as { accessToken: string; refreshToken: string };

  if (!accessToken) {
    throw new Error('No accessToken in login response');
  }

  // 2. Inject auth cookies so the browser session is authenticated
  const url = new URL(apiUrl);
  await page.context().addCookies([
    {
      name: 'koda_token',
      value: accessToken,
      domain: url.hostname,
      path: '/',
      httpOnly: false,
      secure: false,
    },
    {
      name: 'koda_refresh_token',
      value: refreshToken,
      domain: url.hostname,
      path: '/',
      httpOnly: false,
      secure: false,
    },
  ]);

  // 3. Navigate to the app — auth middleware will see the cookie
  await page.goto('/');
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
