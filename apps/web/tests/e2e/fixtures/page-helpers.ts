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
  const webUrl = process.env['E2E_WEB_URL'] ?? 'http://localhost:3103';

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
    data?: { accessToken?: string; refreshToken?: string };
    accessToken?: string;
    refreshToken?: string;
  };
  const accessToken = body.data?.accessToken ?? body.accessToken;
  const refreshToken = body.data?.refreshToken ?? body.refreshToken;

  if (!accessToken) {
    throw new Error('No accessToken in login response');
  }

  // 2. Inject auth cookies so the browser session is authenticated
  const webAppUrl = new URL(webUrl);
  await page.context().addCookies([
    {
      name: 'koda_token',
      value: accessToken,
      domain: webAppUrl.hostname,
      path: '/',
      httpOnly: false,
      secure: false,
    },
    {
      name: 'koda_refresh_token',
      value: refreshToken ?? '',
      domain: webAppUrl.hostname,
      path: '/',
      httpOnly: false,
      secure: false,
    },
  ]);

  // 3. Navigate to the app and wait for full hydration
  // Use networkidle to ensure SSR auth middleware resolves before continuing
  await page.goto(webUrl, { waitUntil: 'networkidle' });

  // 4. Retry a few times if middleware still routes to /login while hydrating
  for (let attempt = 0; attempt < 3 && page.url().endsWith('/login'); attempt += 1) {
    await page.waitForTimeout(300 * (attempt + 1));
    await page.goto(webUrl, { waitUntil: 'networkidle' });
  }

  if (page.url().endsWith('/login')) {
    throw new Error('Web login helper failed to establish authenticated session');
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
