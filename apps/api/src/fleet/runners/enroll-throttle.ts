/**
 * Runner-enrollment throttle limit. Defaults to 10/min in production: the
 * enrollment route is public (the runner proves itself with a single-use
 * token), so the limit is the brute-force defence on that surface.
 *
 * The E2E run raises it via `FLEET_ENROLL_THROTTLE_LIMIT`, like the login
 * (`AUTH_LOGIN_THROTTLE_LIMIT`) and the global (`THROTTLE_LIMIT`) limits: the
 * whole Playwright suite shares one API instance and one client IP, and it
 * enrolls a runner per fleet spec. A throttled enrollment makes the fixture
 * wait for the window to free, which does not fit the 30 s `beforeAll` hook
 * timeout, so the spec fails outright instead of slowing down.
 *
 * Resolved at class-load time: the value is captured into the @Throttle
 * metadata of the guarded handler, so changing the env mid-process has no
 * effect.
 */
const ENROLL_LIMIT = Number.parseInt(process.env['FLEET_ENROLL_THROTTLE_LIMIT'] ?? '10', 10);

export const FLEET_ENROLL_LIMIT = Number.isFinite(ENROLL_LIMIT) && ENROLL_LIMIT > 0 ? ENROLL_LIMIT : 10;

/** One minute — the window the runner-enrollment route is limited over. */
export const FLEET_ENROLL_TTL_MS = 60_000;
