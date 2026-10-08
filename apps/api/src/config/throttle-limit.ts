/**
 * Global (default) throttler limit per client IP per minute. 100 in production.
 * E2E raises it via `THROTTLE_LIMIT` for the same reason as `AUTH_LOGIN_THROTTLE_LIMIT`
 * (auth.controller.ts): every spec shares one client IP, so a full run trips 100/min
 * once each page load also polls the notification bell (S4a).
 */
export const DEFAULT_THROTTLE_LIMIT = 100;

export function globalThrottleLimit(env: Readonly<Record<string, string | undefined>> = process.env): number {
  const parsed = Number.parseInt(env['THROTTLE_LIMIT'] ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_THROTTLE_LIMIT;
}
