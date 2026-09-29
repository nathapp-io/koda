import type { IFleetConfig } from '../../config/fleet.config';

/** A complete IFleetConfig for unit specs; override only what the spec cares about. */
export function testFleetConfig(overrides: Partial<IFleetConfig> = {}): IFleetConfig {
  return {
    githubAppId: undefined,
    githubAppPrivateKeyFile: undefined,
    githubAppSlug: undefined,
    enrollmentTtlSec: 86_400,
    httpTimeoutMs: 10_000,
    runnerOfflineSec: 90,
    jobCrashSec: 300,
    syncWaitMs: 0,
    sweepEnabled: false,
    bundleMaxBytes: 200 * 1024 * 1024,
    artifactDir: '/tmp/koda-fleet-artifacts-unit',
    gitlabBotName: 'koda-fleet',
    gitlabBotEmail: 'koda-fleet@users.noreply.invalid',
    enrollmentRetentionDays: null,
    ...overrides,
  };
}
