import type { RunnerCapabilities } from '../common/protocol';
import { CapabilityValidationError, parseCapabilitiesCore } from '../common/capabilities-core';
import { isRunnerOnline } from '../common/runner-online';
import { FleetJobState } from '../../common/enums';
import {
  AttentionItem, DASHBOARD_LIMITS, DashboardJobRow, DashboardRecentRow, DashboardRunnerRow, DashboardScope, PendingSummary,
} from './dashboard.types';

export interface DashboardCredentialView {
  providerId: string;
  available: boolean;
  kind: 'api-key' | 'oauth' | null;
  expiresAt: string | null;
  expired: boolean;
}

export interface DashboardRunnerView {
  id: string;
  name: string;
  os: string;
  arch: string;
  labels: string[];
  enabled: boolean;
  online: boolean;
  lastSeenAt: string;
  capacity: number;
  activeJobs: number;
  naxVersion: string | null;
  daemonVersion: string | null;
  credentials: DashboardCredentialView[];
}

export interface DashboardActiveJobView {
  id: string;
  projectSlug: string;
  repo: string;
  feature: string;
  command: string;
  state: string;
  runnerId: string | null;
  runnerName: string | null;
  currentStoryId: string | null;
  currentPhase: string | null;
  storiesDone: number | null;
  storiesTotal: number | null;
  costSpentUsd: string;
  maxCostUsd: string;
  queuedAt: string;
  startedAt: string | null;
  lastHeartbeatAt: string | null;
  pendingApprovals: number;
}

export interface DashboardRecentJobView {
  id: string;
  projectSlug: string;
  repo: string;
  feature: string;
  command: string;
  state: string;
  stateReason: string | null;
  runnerName: string | null;
  costSpentUsd: string;
  startedAt: string | null;
  finishedAt: string;
  resultPrUrl: string | null;
}

export interface DashboardCountsView {
  runnersOnline: number;
  runnersTotal: number;
  queued: number;
  running: number;
  attention: number;
}

export interface DashboardView {
  generatedAt: string;
  counts: DashboardCountsView;
  runners: DashboardRunnerView[];
  activeJobs: DashboardActiveJobView[];
  activeTruncated: boolean;
  recentJobs: DashboardRecentJobView[];
  recentTruncated: boolean;
  attention: AttentionItem[];
}

export interface ViewInput {
  scope: DashboardScope;
  now: Date;
  offlineSec: number;
  runners: readonly DashboardRunnerRow[];
  heldByRunner: ReadonlyMap<string, number>;
  /** As read: up to DASHBOARD_LIMITS.activeJobs + 1 (the extra row only sets activeTruncated). */
  active: readonly DashboardJobRow[];
  /** As read: up to DASHBOARD_LIMITS.recentJobs + 1. */
  recent: readonly DashboardRecentRow[];
  counts: ReadonlyMap<string, number>;
  pending: ReadonlyMap<string, PendingSummary>;
  attention: AttentionItem[];
}

/** Spec §1.4: re-validates a stored blob; a corrupt one degrades to null instead of failing the snapshot. */
export function readCapabilities(raw: unknown): RunnerCapabilities | null {
  try {
    return parseCapabilitiesCore(raw);
  } catch (error) {
    if (error instanceof CapabilityValidationError) return null;
    throw error;
  }
}

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

function runnerView(r: DashboardRunnerRow, input: ViewInput): DashboardRunnerView {
  const admin = input.scope.kind === 'global';
  return {
    id: r.id, name: r.name, os: r.os, arch: r.arch, labels: r.labels, enabled: r.enabled,
    online: isRunnerOnline(r.lastSeenAt, input.now, input.offlineSec), lastSeenAt: r.lastSeenAt.toISOString(), capacity: r.capacity,
    activeJobs: input.heldByRunner.get(r.id) ?? 0,
    naxVersion: admin ? (r.capabilities?.nax.version ?? null) : null,
    daemonVersion: admin ? r.daemonVersion : null,
    credentials: admin && r.capabilities
      ? r.capabilities.credentials.map((c) => ({
        providerId: c.providerId, available: c.available, kind: c.stored?.kind ?? null, expiresAt: c.stored?.expires ?? null, expired: c.stored?.expired ?? false,
      }))
      : [],
  };
}

function activeView(j: DashboardJobRow, input: ViewInput, names: ReadonlyMap<string, string>): DashboardActiveJobView {
  const stories = j.stories && !j.storiesTruncated ? j.stories : null;
  return {
    id: j.id, projectSlug: j.projectSlug, repo: `${j.repoOwner}/${j.repoName}`, feature: j.feature, command: j.command, state: j.state,
    runnerId: j.runnerId, runnerName: j.runnerId ? (names.get(j.runnerId) ?? null) : null,
    currentStoryId: j.currentStoryId, currentPhase: j.currentPhase,
    storiesDone: stories ? stories.filter((s) => s.status === 'passed').length : null, storiesTotal: stories ? stories.length : null,
    costSpentUsd: j.costSpentUsd, maxCostUsd: j.maxCostUsd, queuedAt: j.queuedAt.toISOString(), startedAt: iso(j.startedAt),
    lastHeartbeatAt: iso(j.lastHeartbeatAt), pendingApprovals: input.pending.get(j.id)?.count ?? 0,
  };
}

const recentView = (r: DashboardRecentRow): DashboardRecentJobView => ({
  id: r.id, projectSlug: r.projectSlug, repo: `${r.repoOwner}/${r.repoName}`, feature: r.feature, command: r.command, state: r.state,
  stateReason: r.stateReason, runnerName: r.runnerName, costSpentUsd: r.costSpentUsd, startedAt: iso(r.startedAt),
  finishedAt: r.finishedAt.toISOString(), resultPrUrl: r.resultPrUrl,
});

/** Spec §1.2: one consistent snapshot; counts come from the full-scope grouped counts, never the capped lists. */
export function buildDashboardView(input: ViewInput): DashboardView {
  const names = new Map(input.runners.map((r) => [r.id, r.name] as const));
  const runners = input.runners.map((r) => runnerView(r, input));
  const count = (state: string): number => input.counts.get(state) ?? 0;
  return {
    generatedAt: input.now.toISOString(),
    counts: {
      runnersOnline: runners.filter((r) => r.online).length, runnersTotal: runners.length, queued: count(FleetJobState.QUEUED),
      running: count(FleetJobState.ASSIGNED) + count(FleetJobState.RUNNING) + count(FleetJobState.UPLOADING), attention: input.attention.length,
    },
    runners,
    activeJobs: input.active.slice(0, DASHBOARD_LIMITS.activeJobs).map((j) => activeView(j, input, names)),
    activeTruncated: input.active.length > DASHBOARD_LIMITS.activeJobs,
    recentJobs: input.recent.slice(0, DASHBOARD_LIMITS.recentJobs).map(recentView),
    recentTruncated: input.recent.length > DASHBOARD_LIMITS.recentJobs,
    attention: input.attention,
  };
}
