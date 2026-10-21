/**
 * The Playwright e2e suite runs against ONE API instance and one client IP, so every limit the
 * suite itself can exhaust has to be raised for that run — the login throttle (one login per spec
 * and per UI sign-in, plus the CI retries that restart a worker and clear the session cache), the
 * global throttle (the notification bell adds two reads per page load) and the runner-enrollment
 * throttle (one runner per fleet spec).
 *
 * A throttled request is not a slow request here: the login fixture fails fast on a 429 and the
 * enrollment fixture waits for the window, neither of which fits the 30 s hook timeout. One flake
 * would therefore cascade into every later spec and turn the whole `e2e` CI job red.
 */
import config from '../playwright.config';

interface WebServerEntry {
  command: string;
  env?: Record<string, string>;
}

const servers = (config.webServer ?? []) as WebServerEntry[];
const apiServer = servers.find((server) => server.command.includes('prisma migrate reset'));
const apiEnv = apiServer?.env ?? {};

describe('the Playwright e2e API server limits', () => {
  it('serves the API through the webServer that seeds the database', () => {
    expect(apiServer).toBeDefined();
  });

  it('raises the login throttle above the suite\'s own login count', () => {
    expect(Number(apiEnv['AUTH_LOGIN_THROTTLE_LIMIT'])).toBeGreaterThanOrEqual(200);
  });

  it('raises the runner-enrollment throttle above the suite\'s enrollment count', () => {
    expect(Number(apiEnv['FLEET_ENROLL_THROTTLE_LIMIT'])).toBeGreaterThanOrEqual(1000);
  });

  it('keeps the global throttle raised', () => {
    expect(Number(apiEnv['THROTTLE_LIMIT'])).toBeGreaterThanOrEqual(1000);
  });
});
