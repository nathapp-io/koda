import { test, expect } from '@playwright/test'
import { waitForHydration } from './fixtures/page-helpers'
import { readAuthFixture, webUrl } from './fixtures/password-journeys'

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
 * backdated just past the API's 30 s reuse grace: presenting it again is the recovery, at once,
 * instead of after a wait. The reuse grace is what makes this slow — a presentation inside it
 * takes the parallel-refresh path and never compares the User-Agent.
 *
 * The API only recovers a lost response for 20 minutes after the token's use, so the fixture's
 * window closes 19 minutes after the seed. This spec therefore lives in a file that sorts early in
 * the suite, and it says so out loud when the window has closed.
 */
test('the SSR refresh reaches the API with the browser User-Agent', async ({ browser }) => {
  const fixture = readAuthFixture()

  // The API recovers a lost response for 20 minutes after the token's use; the fixture is
  // backdated a minute, so the window closes 19 minutes after the seed.
  const ageMs = Date.now() - fixture.seededAt
  expect(
    ageMs,
    `the seeded refresh fixture is ${Math.round(ageMs / 60000)} minutes old: the suite outran the API's 20-minute lost-response window, so this spec has to run earlier in the suite`,
  ).toBeLessThan(19 * 60_000)

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
