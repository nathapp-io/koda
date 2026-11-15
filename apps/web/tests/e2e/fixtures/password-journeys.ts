/**
 * The fixtures and helpers the password journeys need (koda #466).
 *
 * The e2e API's seed writes the auth fixtures to `$E2E_AUTH_FIXTURE_FILE` — the Playwright config
 * points it at a file under the OS temp directory — and the browser journeys read them back:
 *
 * - one account per reset token (a confirmation spends its token and discards the account's other
 *   outstanding links, so a shared account would let one journey spoil another);
 * - a refresh token that was already used, bound to a known User-Agent: presenting it again is the
 *   lost-response recovery, the only path on which the API compares the User-Agent.
 *
 * A journey cannot build any of these for itself: the reset request route writes no token while
 * email is unconfigured (the e2e API has no SMTP), and only the sha256 of a token is stored.
 */
import { readFileSync } from 'node:fs'
import type { Page } from '@playwright/test'

const API_URL = process.env['E2E_API_URL'] ?? 'http://localhost:3102'

/** The web origin the journeys drive. */
export function webUrl(): string {
  return process.env['E2E_WEB_URL'] ?? 'http://localhost:3103'
}

/** One journey account: the credentials it signs in with and the reset token it presents. */
export interface JourneyAccount {
  email: string
  password: string
  resetToken: string
}

export interface AuthFixture {
  accounts: Record<'valid' | 'replayable' | 'expired' | 'weak', JourneyAccount>
  /** The User-Agent the seeded refresh token is bound to. */
  userAgent: string
  /** A refresh token that was already used once. */
  refreshToken: string
}

let cached: AuthFixture | undefined

/** The auth fixtures the e2e seed wrote. Fails loudly when the seed did not run. */
export function readAuthFixture(): AuthFixture {
  if (cached) return cached
  const file = process.env['E2E_AUTH_FIXTURE_FILE']
  if (!file) {
    throw new Error(
      'E2E_AUTH_FIXTURE_FILE is not set: the password journeys need the e2e seed to write its auth fixtures',
    )
  }
  let parsed: AuthFixture
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8')) as AuthFixture
  } catch (error) {
    throw new Error(
      `Cannot read the e2e auth fixtures at ${file}: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  cached = parsed
  return parsed
}

/**
 * A login attempt that reports the answer instead of throwing: the journeys need both outcomes
 * (the old password must fail, the new one must work).
 */
export async function tryLogin(email: string, password: string): Promise<{ ok: boolean; status: number }> {
  const res = await fetch(`${API_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  })
  return { ok: res.ok, status: res.status }
}

/**
 * Renders the page in Chinese.
 *
 * The app runs @nuxtjs/i18n with the `no_prefix` strategy and `detectBrowserLanguage.useCookie`,
 * and with that strategy the module reads the `koda_locale` cookie while it renders on the server —
 * so one cookie is enough, and no reload dance is needed.
 */
export async function useChineseLocale(page: Page): Promise<void> {
  await page.context().addCookies([{ name: 'koda_locale', value: 'zh', url: webUrl() }])
}
