import { fleetConfig, isGitHubAppConfigured } from './fleet.config';
import { validate } from './env.validation';

const BASE = {
  DATABASE_URL: 'postgresql://x', JWT_SECRET: 'a', JWT_REFRESH_SECRET: 'b', API_KEY_SECRET: 'c',
};

describe('fleet config', () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  it('defaults the enrollment TTL to 24h and the HTTP timeout to 10s', () => {
    delete process.env.FLEET_ENROLLMENT_TTL_SEC;
    delete process.env.FLEET_HTTP_TIMEOUT_MS;
    const cfg = fleetConfig();
    expect(cfg.enrollmentTtlSec).toBe(86_400);
    expect(cfg.httpTimeoutMs).toBe(10_000);
  });

  it('is GitHub-App-configured only when id, key file and slug are all set', () => {
    process.env.GITHUB_APP_ID = '123';
    process.env.GITHUB_APP_PRIVATE_KEY_FILE = '/k.pem';
    delete process.env.GITHUB_APP_SLUG;
    expect(isGitHubAppConfigured(fleetConfig())).toBe(false);
    process.env.GITHUB_APP_SLUG = 'koda-fleet';
    expect(isGitHubAppConfigured(fleetConfig())).toBe(true);
  });

  it.each([
    ['GITHUB_APP_ID', 'abc'],
    ['FLEET_ENROLLMENT_TTL_SEC', '30'],
    ['FLEET_HTTP_TIMEOUT_MS', '0'],
  ])('refuses boot on a bad %s', (key, value) => {
    expect(() => validate({ ...BASE, [key]: value })).toThrow();
  });
});
