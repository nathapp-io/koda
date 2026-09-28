import type { Page } from '@playwright/test';
import { randomBytes } from 'node:crypto';
import { E2E_ADMIN } from './api-client';
import { getSession } from './session';

export function generateUniqueProjectKey(prefix = 'EE'): string {
  const normalizedPrefix = prefix.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 2) || 'EE';
  const suffixLength = 6 - normalizedPrefix.length;
  const suffix = Array.from(randomBytes(suffixLength), (byte) => String.fromCharCode(65 + (byte % 26))).join('');
  return `${normalizedPrefix}${suffix}`;
}

/**
 * Nuxt hydration resets the SSR DOM to v-model state when the client takes
 * over, so anything clicked before hydration is lost (the click handler is
 * not attached yet). Await this after `page.goto` before clicking buttons.
 */
export async function waitForHydration(page: Page) {
  await page.waitForFunction(() => {
    const useNuxtApp = (window as { useNuxtApp?: () => { isHydrating: boolean } }).useNuxtApp;
    return !!useNuxtApp && useNuxtApp().isHydrating === false;
  }, undefined, { timeout: 15000 });
}

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
  opts: { fresh?: boolean } = {},
) {
  const webUrl = process.env['E2E_WEB_URL'] ?? 'http://localhost:3103';

  // 1. One cached API login per user per worker (see fixtures/session.ts)
  const { accessToken, refreshToken } = await getSession(email, password, opts);

  // 2. Inject auth cookies so the browser session is authenticated
  await page.context().addCookies([
    {
      name: 'koda_token',
      value: accessToken,
      url: webUrl,
      httpOnly: false,
      secure: false,
    },
    {
      name: 'koda_refresh',
      value: refreshToken,
      url: webUrl,
      httpOnly: false,
      secure: false,
    },
  ]);

  // 3. Navigate to the app and wait for full hydration
  // Use networkidle to ensure SSR auth middleware resolves before continuing
  // networkidle is safe here only while the dashboard opens no live stream; switch to waitForHydration if it ever does.
  await page.goto(webUrl, { waitUntil: 'networkidle' });

  // 4. Retry a few times if middleware still routes to /login while hydrating
  for (let attempt = 0; attempt < 3 && page.url().endsWith('/login'); attempt += 1) {
    await page.waitForTimeout(300 * (attempt + 1));
    // networkidle is safe here only while the dashboard opens no live stream; switch to waitForHydration if it ever does.
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
