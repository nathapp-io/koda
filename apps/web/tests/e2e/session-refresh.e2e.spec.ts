import { test, expect } from '@playwright/test'
import { waitForHydration, webLogin } from './fixtures/page-helpers'
import { readAuthFixture, webUrl } from './fixtures/password-journeys'

/**
 * D/BUG-1 (US-009): the access cookie lives 15 minutes and the refresh cookie 7
 * days, so a signed-in browser that reloads any page more than 15 minutes after
 * its last refresh arrives with only `koda_refresh`. The Nitro
 * `server/middleware/session-refresh.ts` redeems that cookie before the render,
 * so the SSR pass sees a session instead of bouncing to /login.
 *
 * Note: `/projects` cannot be used here — `pages/projects.vue` answers a
 * permanent 301 to `/` (the dashboard), so a `/projects` load can never end on
 * `/projects`. The authenticated dashboard at `/` is the equivalent full page
 * load.
 */
test('SSR refresh keeps a reloaded page signed in after only the access cookie is deleted', async ({ page }) => {
  await webLogin(page)
  const webUrl = process.env['E2E_WEB_URL'] ?? 'http://localhost:3103'

  const cookies = await page.context().cookies()
  expect(cookies.find((cookie) => cookie.name === 'koda_refresh')?.value ?? '').not.toBe('')

  // Every document response of the reloaded page, one per server render: a
  // render that gave up on the session answers with a `location` to /login.
  const documents: Array<{ status: number; location: string }> = []
  page.on('response', (response) => {
    if (response.request().resourceType() !== 'document') return
    documents.push({ status: response.status(), location: response.headers()['location'] ?? '' })
  })

  await page.context().clearCookies({ name: 'koda_token' })
  await page.goto(`${webUrl}/`)
  await waitForHydration(page)

  // The server render itself must not redirect: the session was refreshed first.
  expect(documents.length).toBeGreaterThan(0)
  expect(documents.find((document) => document.location !== '')).toBeUndefined()
  expect(documents[0]?.status).toBe(200)

  // ...and the browser stays on the dashboard with a fresh access cookie.
  await expect(page).not.toHaveURL(/\/login/)
  await expect(page).toHaveURL(`${webUrl}/`)
  const restored = await page.context().cookies(webUrl)
  expect(restored.find((cookie) => cookie.name === 'koda_token')?.value ?? '').not.toBe('')
})

/**
 * koda #466: the browser's User-Agent has to reach the API.
 *
 * The API binds a refresh token to the client that first used it (`RefreshToken.usedUaHash`, the
 * sha256 of the User-Agent) and a *lost-response recovery* — the browser presenting a token whose
 * successor never arrived — is only granted when the presented hash matches. A Nuxt server that
 * dropped the `User-Agent` would bind every token to the empty string and log the user out on the
 * next lost response, so the hop is worth proving end to end.
 *
 * The seed hands over a refresh token that was already used, bound to a known User-Agent and
 * backdated past the API's 30 s reuse grace: presenting it again is the recovery, at once, instead
 * of after a wait. The reuse grace is what makes this slow — a presentation inside it takes the
 * parallel-refresh path and never compares the User-Agent.
 */
test('the SSR refresh reaches the API with the browser User-Agent', async ({ browser }) => {
  const fixture = readAuthFixture()
  const context = await browser.newContext({ userAgent: fixture.userAgent })
  const page = await context.newPage()

  // Only the refresh cookie: the access cookie is what the SSR refresh is for.
  await context.addCookies([
    { name: 'koda_refresh', value: fixture.refreshToken, url: webUrl(), httpOnly: false, secure: false },
  ])

  await page.goto(webUrl())
  await waitForHydration(page)

  // The API granted the recovery and answered a fresh pair, so the server set the access cookie.
  const cookies = await context.cookies()
  expect(cookies.find((cookie) => cookie.name === 'koda_token')?.value ?? '').not.toBe('')
  // ...and the page is signed in instead of bounced to the login.
  await expect(page).not.toHaveURL(/\/login/)

  await context.close()
})
