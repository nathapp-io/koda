import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { waitForHydration, webLogin } from './fixtures/page-helpers';

/**
 * Review-1118 US-005 B4: the outage page's Retry must ask the API about the session again, even when the destination it
 * recorded is the URL the outage page is already standing on.
 *
 * That is the deep-link case: `/agents#staff` aborts during the initial pass, so the outage page keeps that URL and
 * records it as `data.redirect`. `location.assign('/agents#staff')` from `/agents` is then a *same-document* fragment
 * navigation — the browser changes the URL and scrolls but sends no request and re-runs no route guard, so the outage
 * page would sit there for good. The component reloads the document instead, which re-runs the guard (and its
 * `/api/auth/me` probe) from scratch.
 */

/** The two Nuxt client internals this journey drives; see apps/web/node_modules/nuxt/dist/app. */
interface NuxtWindow extends Window {
  useNuxtApp: () => {
    payload: { state: Record<string, unknown> };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    $router: { push: (to: string) => Promise<any> };
  };
}

/**
 * Fails the browser's own auth probes the way an upstream deploy does: `server/api/auth/me.get.ts` answers 503 when the
 * API cannot be reached, which is the page-load outage the error page exists for.
 */
async function failBrowserAuthProbes(page: Page): Promise<{ reads: () => number }> {
  let probes = 0;
  await page.route('**/api/auth/me', (route) => {
    probes += 1;
    return route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ statusCode: 503, statusMessage: 'Service Unavailable' }),
    });
  });
  return { reads: () => probes };
}

test.describe('Session outage page', () => {
  test('Retry on a destination that matches the current URL re-runs the auth probe (B4)', async ({ page }) => {
    await webLogin(page);
    await page.goto('/agents');
    await waitForHydration(page);
    await expect(page.getByRole('heading', { name: 'Agents', exact: true })).toBeVisible();

    const probes = await failBrowserAuthProbes(page);

    // Drop the in-memory session the way a refused refresh does (`refreshSession` -> 401 -> user = null) without
    // touching the cookies, then navigate inside the app to the same path with a fragment. Vue Router compares the
    // hash, so the guards still run: the middleware probes /api/auth/me, meets the outage, and aborts with
    // `data.redirect` = '/agents#staff'.
    await page.evaluate(async () => {
      const app = (window as unknown as NuxtWindow).useNuxtApp();
      for (const key of Object.keys(app.payload.state)) {
        if (key.endsWith('koda_user')) app.payload.state[key] = null;
      }
      await app.$router.push('/agents#staff').catch(() => {});
    });

    const retry = page.getByTestId('error-page-retry');
    await expect(retry).toBeVisible();
    expect(probes.reads()).toBeGreaterThanOrEqual(1);
    // The outage page is standing on the destination's path and query, so only the fragment separates the two: the
    // case `location.assign` cannot navigate to a document.
    await expect(page).toHaveURL(/\/agents(#staff)?$/);

    // The proxy, not page.route, observes SSR calls made during a document reload. Scope the counter to this
    // session so unrelated auth probes cannot satisfy the regression. Keep failing browser probes: only a fresh
    // server-side probe can increase this count and recover the page.
    const token = (await page.context().cookies()).find((cookie) => cookie.name === 'koda_token')?.value;
    expect(token).toBeTruthy();
    const upstreamProbes = async (): Promise<number> => {
      const response = await page.request.get(`${process.env['E2E_AUTH_PROXY_URL']}/__test/auth-probes`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(response.ok()).toBe(true);
      return (await response.json() as { probes: number }).probes;
    };
    const beforeRetry = await upstreamProbes();

    // Only the retry's own document requests count from here.
    const documentRequests: string[] = [];
    page.on('request', (request) => {
      if (request.resourceType() === 'document') documentRequests.push(request.url());
    });

    await retry.click();

    // A reload: the error page goes away, the destination fragment is kept, and the server answered the probe on the
    // way (which is why the page renders instead of showing the outage page again).
    await expect(retry).toHaveCount(0);
    await expect(page).toHaveURL(/\/agents#staff$/);
    await expect(page.getByRole('heading', { name: 'Agents', exact: true })).toBeVisible();
    // A fragment is never sent on the wire, so the request carries the path without it.
    expect(documentRequests).toEqual([expect.stringMatching(/\/agents$/)]);
    await expect.poll(upstreamProbes).toBeGreaterThan(beforeRetry);
  });
});
