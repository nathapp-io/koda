import type { Page } from '@playwright/test';
import { E2E_ADMIN } from './api-client';

/**
 * Performs login by calling the API directly, then injecting the auth cookie
 * into the Playwright browser context.
 *
 * After injecting the cookie, we navigate to '/' and wait for the page to
 * fully hydrate so auth middleware has resolved the cookie on both SSR and
 * client side before proceeding.
 */
export async function webLogin(
  page: Page,
  email = E2E_ADMIN.email,
  password = E2E_ADMIN.password,
) {
  const apiUrl = process.env['E2E_API_URL'] ?? 'http://localhost:3102';

  // 1. Call the API directly to get an access token
  const response = await page.request.post(`${apiUrl}/api/auth/login`, {
    data: { email, password },
  });

  if (!response.ok()) {
    throw new Error(
      `Login API failed: ${response.status()} ${response.statusText()} ${await response.text()}`,
    );
  }

  const body = (await response.json()) as {
    ret: number;
    data: { accessToken: string; refreshToken: string };
  };
  const { accessToken, refreshToken } = body.data ?? body as unknown as {
    accessToken: string;
    refreshToken: string;
  };

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

  // 3. Navigate to the app and wait for full hydration
  // Use networkidle to ensure SSR auth middleware resolves before continuing
  await page.goto(`${url.protocol}//${url.host}/`, { waitUntil: 'networkidle' });

  // 4. If we ended up on /login (auth middleware rejected the cookie),
  //    wait a moment and retry once
  if (page.url().endsWith('/login')) {
    await page.waitForTimeout(500);
    await page.goto(`${url.protocol}//${url.host}/`, { waitUntil: 'networkidle' });
  }
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
