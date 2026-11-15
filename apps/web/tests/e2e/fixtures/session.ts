/**
 * Two kinds of e2e login, kept apart on purpose (auth-sessions, #460):
 *
 * - `getSession` — one cached API login per user per Playwright worker, for the
 *   API client (fixtures/api-client.ts). It only ever presents its access token,
 *   so its session never rotates. Tokens are reused for up to 10 minutes
 *   (access tokens live 15).
 * - `newBrowserSession` — an uncached login for one browser context
 *   (`webLogin`). A browser rotates its refresh cookie (SSR refresh, the 401
 *   retry, the refresh route), and the API revokes a whole session when a used
 *   refresh token is presented again after the 30 s reuse grace. Sharing one
 *   refresh token between contexts would let one test's rotation revoke the
 *   session every later test (and the API client) runs on.
 *
 * POST /auth/logout revokes only the session the token names, so a browser
 * logout no longer touches the cached API session.
 *
 * Logins are throttled per IP (all e2e traffic is 127.0.0.1); playwright.config
 * raises AUTH_LOGIN_THROTTLE_LIMIT for the suite. A 429 fails fast with a clear
 * message instead of sleeping out the throttle window.
 */
const API_URL = process.env['E2E_API_URL'] ?? 'http://localhost:3102';
const MAX_AGE_MS = 10 * 60_000;

export interface E2ESession {
  accessToken: string;
  refreshToken: string;
  userId: string;
  obtainedAt: number;
}

let cache: ReadonlyMap<string, E2ESession> = new Map();

async function loginOnce(email: string, password: string): Promise<E2ESession> {
  const res = await fetch(`${API_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (res.status === 429) {
    throw new Error(
      'Login throttled (429): too many logins/min from this IP. Raise AUTH_LOGIN_THROTTLE_LIMIT in playwright.config.ts.',
    );
  }
  if (!res.ok) throw new Error(`Login failed: ${res.status} ${await res.text()}`);
  const body = (await res.json()) as {
    data?: { accessToken?: string; refreshToken?: string; user?: { id?: string } };
  };
  const accessToken = body.data?.accessToken;
  const refreshToken = body.data?.refreshToken;
  const userId = body.data?.user?.id;
  if (!accessToken || !refreshToken || !userId) {
    throw new Error('Login response missing accessToken, refreshToken or user id');
  }
  return { accessToken, refreshToken, userId, obtainedAt: Date.now() };
}

export async function getSession(email: string, password: string): Promise<E2ESession> {
  const cached = cache.get(email);
  if (cached && Date.now() - cached.obtainedAt < MAX_AGE_MS) return cached;
  const session = await loginOnce(email, password);
  cache = new Map([...cache, [email, session]]);
  return session;
}

/** A session of its own for one browser context; never cached (see the header). */
export async function newBrowserSession(email: string, password: string): Promise<E2ESession> {
  return await loginOnce(email, password);
}
