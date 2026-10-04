import { validateUtil } from '@nathapp/nestjs-common';
import { registerAs } from '@nestjs/config';
import { IsOptional, IsString } from 'class-validator';
import { resolve } from 'path';

export const FLEET_CFG = 'fleet';

export interface IFleetConfig {
  githubAppId: string | undefined;
  githubAppPrivateKeyFile: string | undefined;
  githubAppSlug: string | undefined;
  enrollmentTtlSec: number;
  httpTimeoutMs: number;
  /** A runner is offline after this many seconds without a sync (spec §4, §5.3). */
  runnerOfflineSec: number;
  /** An active job of a silent runner becomes CRASHED after this many seconds (spec §5.3). */
  jobCrashSec: number;
  /** Long-poll wait when a sync has nothing to return (spec §3.2); 0 answers at once. */
  syncWaitMs: number;
  /** In-process silence sweep (plan D11). */
  sweepEnabled: boolean;
  bundleMaxBytes: number;
  /** S2a §7: per stream per attempt cap. */
  logMaxBytes: number;
  /** S2a §7: max body per log upload. */
  logChunkMaxBytes: number;
  /** S2a §2.2.1: per-runner upload rate. */
  logRunnerBytesPerSec: number;
  /** Absolute root of LocalDiskArtifactStore (spec §8). */
  artifactDir: string;
  gitlabBotName: string;
  gitlabBotEmail: string;
  /** Days a consumed or expired enrollment row survives (#162); null disables the purge. */
  enrollmentRetentionDays: number | null;
  /** Seconds before a cached GitHub App installation token's expiry that we still hand it out (review 2b DOC-5). */
  gitTokenReuseMarginSec: number;
  /** Seconds a freshly minted GitLab token is considered valid for; the broker never lets it outlive this. */
  gitlabTokenTtlSec: number;
  /** Test-only HTTP hooks (S1b 3b D213): FLEET_TEST_HOOKS=true, and never under NODE_ENV=production. */
  testHooksEnabled: boolean;
}

export class FleetConfigSchema {
  @IsOptional() @IsString() GITHUB_APP_ID: string;
  @IsOptional() @IsString() GITHUB_APP_PRIVATE_KEY_FILE: string;
  @IsOptional() @IsString() GITHUB_APP_SLUG: string;
  @IsOptional() @IsString() FLEET_ENROLLMENT_TTL_SEC: string;
  @IsOptional() @IsString() FLEET_HTTP_TIMEOUT_MS: string;
  @IsOptional() @IsString() FLEET_RUNNER_OFFLINE_SEC: string;
  @IsOptional() @IsString() FLEET_JOB_CRASH_SEC: string;
  @IsOptional() @IsString() FLEET_SYNC_WAIT_MS: string;
  @IsOptional() @IsString() FLEET_SWEEP_ENABLED: string;
  @IsOptional() @IsString() FLEET_BUNDLE_MAX_BYTES: string;
  @IsOptional() @IsString() FLEET_LOG_MAX_BYTES: string;
  @IsOptional() @IsString() FLEET_LOG_CHUNK_MAX_BYTES: string;
  @IsOptional() @IsString() FLEET_LOG_RUNNER_BYTES_PER_SEC: string;
  @IsOptional() @IsString() FLEET_ARTIFACT_DIR: string;
  @IsOptional() @IsString() FLEET_GITLAB_BOT_NAME: string;
  @IsOptional() @IsString() FLEET_GITLAB_BOT_EMAIL: string;
  @IsOptional() @IsString() FLEET_ENROLLMENT_RETENTION_DAYS: string;
  @IsOptional() @IsString() FLEET_GIT_TOKEN_REUSE_MARGIN_SEC: string;
  @IsOptional() @IsString() FLEET_GITLAB_TOKEN_TTL_SEC: string;
  @IsOptional() @IsString() FLEET_TEST_HOOKS: string;
}

const int = (key: string, fallback: number): number => Number.parseInt(process.env[key] ?? String(fallback), 10);
const isTest = (): boolean => process.env['NODE_ENV'] === 'test';

/** Same default rule as OUTBOX_RETENTION_DAYS: 30 outside tests, off in tests, 0 is the kill switch. */
function retentionDays(): number | null {
  const raw = process.env['FLEET_ENROLLMENT_RETENTION_DAYS'];
  if (raw === undefined) return isTest() ? null : 30;
  const days = Number.parseInt(raw, 10);
  return days > 0 ? days : null;
}

export const fleetConfig = registerAs(FLEET_CFG, (): IFleetConfig => {
  validateUtil(process.env, FleetConfigSchema);
  const sweep = process.env['FLEET_SWEEP_ENABLED'];
  return {
    githubAppId: process.env['GITHUB_APP_ID'] || undefined,
    githubAppPrivateKeyFile: process.env['GITHUB_APP_PRIVATE_KEY_FILE'] || undefined,
    githubAppSlug: process.env['GITHUB_APP_SLUG'] || undefined,
    enrollmentTtlSec: int('FLEET_ENROLLMENT_TTL_SEC', 86_400),
    httpTimeoutMs: int('FLEET_HTTP_TIMEOUT_MS', 10_000),
    runnerOfflineSec: int('FLEET_RUNNER_OFFLINE_SEC', 90),
    jobCrashSec: int('FLEET_JOB_CRASH_SEC', 300),
    syncWaitMs: int('FLEET_SYNC_WAIT_MS', 25_000),
    sweepEnabled: sweep !== undefined ? sweep.toLowerCase() === 'true' : !isTest(),
    bundleMaxBytes: int('FLEET_BUNDLE_MAX_BYTES', 200 * 1024 * 1024),
    logMaxBytes: int('FLEET_LOG_MAX_BYTES', 256 * 1024 * 1024),
    logChunkMaxBytes: int('FLEET_LOG_CHUNK_MAX_BYTES', 1024 * 1024),
    logRunnerBytesPerSec: int('FLEET_LOG_RUNNER_BYTES_PER_SEC', 4 * 1024 * 1024),
    artifactDir: resolve(process.env['FLEET_ARTIFACT_DIR'] || './data/fleet-artifacts'),
    gitlabBotName: process.env['FLEET_GITLAB_BOT_NAME'] || 'koda-fleet',
    gitlabBotEmail: process.env['FLEET_GITLAB_BOT_EMAIL'] || 'koda-fleet@users.noreply.invalid',
    enrollmentRetentionDays: retentionDays(),
    gitTokenReuseMarginSec: int('FLEET_GIT_TOKEN_REUSE_MARGIN_SEC', 300),
    gitlabTokenTtlSec: int('FLEET_GITLAB_TOKEN_TTL_SEC', 3_600),
    testHooksEnabled: (process.env['FLEET_TEST_HOOKS'] ?? '').toLowerCase() === 'true' && process.env['NODE_ENV'] !== 'production',
  };
});

export function isGitHubAppConfigured(cfg: Pick<IFleetConfig, 'githubAppId' | 'githubAppPrivateKeyFile' | 'githubAppSlug'>): boolean {
  return Boolean(cfg.githubAppId && cfg.githubAppPrivateKeyFile && cfg.githubAppSlug);
}
