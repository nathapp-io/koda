/**
 * Login/register/logout/public-invite throttle limit. Defaults to 5/min in
 * production — the spec calls this out as the brute-force defense on the auth
 * surface. E2E tests raise this via `AUTH_LOGIN_THROTTLE_LIMIT` because every
 * spec shares the same client IP and every web login in the suite is a login
 * of its own (one session per browser context).
 *
 * Resolved at class-load time: the value is captured into the @Throttle
 * metadata of every guarded handler, so changing the env mid-process has no
 * effect.
 */
const AUTH_LIMIT = Number.parseInt(process.env['AUTH_LOGIN_THROTTLE_LIMIT'] ?? '5', 10);

export const AUTH_LOGIN_LIMIT = Number.isFinite(AUTH_LIMIT) && AUTH_LIMIT > 0 ? AUTH_LIMIT : 5;

/** One minute — the window every auth-shaped route (login, register, logout, public invites) is limited over. */
export const AUTH_LOGIN_TTL_MS = 60_000;
