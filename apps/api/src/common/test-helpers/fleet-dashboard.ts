import type { RunnerCapabilities } from '../../fleet/common/protocol';
import type { AttentionThresholds, DashboardJobRow, DashboardRunnerRow } from '../../fleet/dashboard/dashboard.types';

/** Fixed clock for dashboard unit specs. */
export const DASH_NOW = new Date('2026-10-05T12:00:00.000Z');
export const secAgo = (sec: number): Date => new Date(DASH_NOW.getTime() - sec * 1000);

/** The spec §2 defaults. */
export const DASH_THRESHOLDS: AttentionThresholds = {
  runnerOfflineSec: 90, jobSilentSec: 180, jobSilentErrorSec: 600, jobStartSec: 300, jobQueuedWarnSec: 60, credentialExpiryWarnDays: 7,
};

export const dashCaps = (over: Partial<RunnerCapabilities> = {}): RunnerCapabilities => ({
  nax: { version: '0.83.3', protocols: ['native'] },
  sandbox: { available: true, probedAt: DASH_NOW.toISOString() },
  profiles: { fast: { protocol: 'native', providers: ['deepseek'], sandbox: false } },
  credentials: [{ providerId: 'deepseek', available: true, stored: { kind: 'api-key', expired: false }, ambient: false }],
  tools: { git: true, gh: true, glab: true },
  executors: ['host'],
  approvals: { relay: true },
  ...over,
});

export const dashRunner = (over: Partial<DashboardRunnerRow> = {}): DashboardRunnerRow => ({
  id: 'r1', name: 'wk-mac', os: 'darwin', arch: 'arm64', labels: ['mac'], enabled: true, lastSeenAt: secAgo(10), capacity: 1,
  daemonVersion: '0.4.0', capabilities: dashCaps(), ...over,
});

export const dashJob = (over: Partial<DashboardJobRow> = {}): DashboardJobRow => ({
  id: 'j1', projectId: 'p1', projectSlug: 'web', projectDeleted: false, repoId: 'repo1', repoOwner: 'acme', repoName: 'app', provider: 'github',
  feature: 'add-auth', command: 'RUN', state: 'RUNNING', runnerId: 'r1', currentStoryId: 'US-001', currentPhase: 'implement',
  stories: null, storiesTruncated: false, costSpentUsd: '0.42', maxCostUsd: '2', queuedAt: secAgo(900), assignedAt: secAgo(890),
  startedAt: secAgo(880), lastHeartbeatAt: secAgo(30), profiles: ['fast'], selectorLabels: [], pinnedRunnerId: null, bashMode: 'raw', ...over,
});
