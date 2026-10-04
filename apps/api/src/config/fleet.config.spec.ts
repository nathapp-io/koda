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

  it('defaults the slice 2 settings outside tests', () => {
    process.env.NODE_ENV = 'production';
    for (const k of ['FLEET_RUNNER_OFFLINE_SEC', 'FLEET_JOB_CRASH_SEC', 'FLEET_SYNC_WAIT_MS', 'FLEET_SWEEP_ENABLED',
      'FLEET_BUNDLE_MAX_BYTES', 'FLEET_ARTIFACT_DIR', 'FLEET_GITLAB_BOT_NAME', 'FLEET_GITLAB_BOT_EMAIL',
      'FLEET_ENROLLMENT_RETENTION_DAYS', 'FLEET_LOG_MAX_BYTES', 'FLEET_LOG_CHUNK_MAX_BYTES',
      'FLEET_LOG_RUNNER_BYTES_PER_SEC', 'FLEET_LOG_SCAN_BYTES']) delete process.env[k];
    const cfg = fleetConfig();
    expect(cfg).toEqual(expect.objectContaining({
      runnerOfflineSec: 90, jobCrashSec: 300, syncWaitMs: 25_000, sweepEnabled: true,
      bundleMaxBytes: 200 * 1024 * 1024, logMaxBytes: 268435456, logChunkMaxBytes: 1048576,
      logRunnerBytesPerSec: 4194304, gitlabBotName: 'koda-fleet', enrollmentRetentionDays: 30,
      logScanBytes: 2097152,
    }));
    expect(cfg.artifactDir).toMatch(/data[/\\]fleet-artifacts$/);
    expect(cfg.artifactDir.startsWith('/') || /^[A-Z]:/i.test(cfg.artifactDir)).toBe(true);
  });

  it('turns the sweep and the enrollment purge off under NODE_ENV=test unless overridden', () => {
    process.env.NODE_ENV = 'test';
    delete process.env.FLEET_SWEEP_ENABLED;
    delete process.env.FLEET_ENROLLMENT_RETENTION_DAYS;
    expect(fleetConfig()).toEqual(expect.objectContaining({ sweepEnabled: false, enrollmentRetentionDays: null }));
    process.env.FLEET_SWEEP_ENABLED = 'TRUE';
    process.env.FLEET_ENROLLMENT_RETENTION_DAYS = '7';
    expect(fleetConfig()).toEqual(expect.objectContaining({ sweepEnabled: true, enrollmentRetentionDays: 7 }));
    process.env.FLEET_ENROLLMENT_RETENTION_DAYS = '0';
    expect(fleetConfig().enrollmentRetentionDays).toBeNull();
  });

  it('enables the test hooks only for FLEET_TEST_HOOKS=true outside production (3b D213)', () => {
    process.env.NODE_ENV = 'development';
    delete process.env.FLEET_TEST_HOOKS;
    expect(fleetConfig().testHooksEnabled).toBe(false);
    process.env.FLEET_TEST_HOOKS = 'TRUE';
    expect(fleetConfig().testHooksEnabled).toBe(true);
    process.env.FLEET_TEST_HOOKS = 'false';
    expect(fleetConfig().testHooksEnabled).toBe(false);
    process.env.NODE_ENV = 'production';
    process.env.FLEET_TEST_HOOKS = 'true';
    expect(fleetConfig().testHooksEnabled).toBe(false);
  });

  it('refuses boot on a FLEET_TEST_HOOKS that is not true or false', () => {
    expect(() => validate({ ...BASE, FLEET_TEST_HOOKS: 'yes' })).toThrow();
    expect(() => validate({ ...BASE, FLEET_TEST_HOOKS: 'true' })).not.toThrow();
  });

  it.each([
    ['FLEET_RUNNER_OFFLINE_SEC', '5'],
    ['FLEET_JOB_CRASH_SEC', '10'],
    ['FLEET_SYNC_WAIT_MS', '-1'],
    ['FLEET_SWEEP_ENABLED', 'yes'],
    ['FLEET_BUNDLE_MAX_BYTES', '10'],
    ['FLEET_GITLAB_BOT_EMAIL', 'not-an-email'],
    ['FLEET_ENROLLMENT_RETENTION_DAYS', '-3'],
    ['FLEET_LOG_SCAN_BYTES', '1024'],
  ])('refuses boot on a bad slice 2 value %s=%s', (key, value) => {
    expect(() => validate({ ...BASE, [key]: value })).toThrow();
  });
});
