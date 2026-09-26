/**
 * One API login per user per Playwright worker. The API throttles login to
 * 5/min per IP (all e2e traffic is 127.0.0.1), so logging in per test trips
 * 429. Tokens are reused for up to 10 minutes (access tokens live 15).
 *
 * POST /auth/logout bumps the user's tokenVersion and revokes every cached
 * token: a test that logs out must use { fresh: true } and call
 * forgetSession() afterwards.
 *
 * A 429 fails fast with a clear message instead of sleeping: Playwright hooks
 * share the 30 s test timeout, so waiting out the 60 s throttle window would
 * fail anyway. A worker restarted after a failure (CI retries) empties this
 * cache and logs in again; that stays well under 5/min unless many tests fail.
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
      'Login throttled (429): more than 5 logins/min from this IP. Reuse getSession() instead of logging in per test.',
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

export async function getSession(
  email: string,
  password: string,
  opts: { fresh?: boolean } = {},
): Promise<E2ESession> {
  const cached = cache.get(email);
  if (!opts.fresh && cached && Date.now() - cached.obtainedAt < MAX_AGE_MS) return cached;
  const session = await loginOnce(email, password);
  cache = new Map([...cache, [email, session]]);
  return session;
}

export function forgetSession(email: string): void {
  const next = new Map(cache);
  next.delete(email);
  cache = next;
}
