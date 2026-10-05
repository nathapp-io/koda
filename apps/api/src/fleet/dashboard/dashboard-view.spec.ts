import { DASH_NOW, dashCaps, dashJob, dashRunner, secAgo } from '../../common/test-helpers/fleet-dashboard';
import { buildDashboardView, readCapabilities, ViewInput } from './dashboard-view';
import type { DashboardRecentRow } from './dashboard.types';

const recent = (over: Partial<DashboardRecentRow> = {}): DashboardRecentRow => ({
  id: 'd1', projectSlug: 'web', repoOwner: 'acme', repoName: 'app', feature: 'done', command: 'RUN', state: 'COMPLETED', stateReason: null,
  runnerName: 'wk-mac', costSpentUsd: '0.1', startedAt: secAgo(4000), finishedAt: secAgo(3600), resultPrUrl: null, ...over,
});

const input = (over: Partial<ViewInput> = {}): ViewInput => ({
  scope: { kind: 'global' }, now: DASH_NOW, offlineSec: 90,
  runners: [dashRunner(), dashRunner({ id: 'r2', name: 'old-box', lastSeenAt: secAgo(500), capabilities: null })],
  heldByRunner: new Map([['r1', 1]]),
  active: [dashJob({ stories: [
    { id: 'US-1', title: 'a', status: 'passed', attempts: 1, dependsOn: [] },
    { id: 'US-2', title: 'b', status: 'in-progress', attempts: 1, dependsOn: [] },
  ] })],
  recent: [recent()], counts: new Map([['RUNNING', 1], ['QUEUED', 3], ['ASSIGNED', 1]]),
  pending: new Map([['j1', { jobId: 'j1', count: 2, oldestRequestedAt: secAgo(60) }]]), attention: [],
  ...over,
});

describe('readCapabilities (spec §1.4)', () => {
  it('returns a clean copy of a valid blob and null for a corrupt one', () => {
    expect(readCapabilities(dashCaps())?.nax.version).toBe('0.83.3');
    expect(readCapabilities({ nax: 'nope' })).toBeNull();
    expect(readCapabilities(null)).toBeNull();
  });
});

describe('buildDashboardView (spec §1.2)', () => {
  it('builds counts over the full scope and the admin runner digest', () => {
    const v = buildDashboardView(input());
    expect(v.generatedAt).toBe(DASH_NOW.toISOString());
    expect(v.counts).toEqual({ runnersOnline: 1, runnersTotal: 2, queued: 3, running: 2, attention: 0 });
    expect(v.runners[0]).toEqual({
      id: 'r1', name: 'wk-mac', os: 'darwin', arch: 'arm64', labels: ['mac'], enabled: true, online: true, lastSeenAt: secAgo(10).toISOString(),
      capacity: 1, activeJobs: 1, naxVersion: '0.83.3', daemonVersion: '0.4.0',
      credentials: [{ providerId: 'deepseek', available: true, kind: 'api-key', expiresAt: null, expired: false }],
    });
    expect(v.runners[1]).toEqual(expect.objectContaining({ online: false, activeJobs: 0, naxVersion: null, credentials: [] }));
  });

  it('hides versions and credentials in project scope (B5)', () => {
    const v = buildDashboardView(input({ scope: { kind: 'project', projectId: 'p1' } }));
    expect(v.runners[0]).toEqual(expect.objectContaining({ naxVersion: null, daemonVersion: null, credentials: [] }));
  });

  it('maps active jobs with stories progress, runner name and pending approvals', () => {
    expect(buildDashboardView(input()).activeJobs[0]).toEqual({
      id: 'j1', projectSlug: 'web', repo: 'acme/app', feature: 'add-auth', command: 'RUN', state: 'RUNNING', runnerId: 'r1', runnerName: 'wk-mac',
      currentStoryId: 'US-001', currentPhase: 'implement', storiesDone: 1, storiesTotal: 2, costSpentUsd: '0.42', maxCostUsd: '2',
      queuedAt: secAgo(900).toISOString(), startedAt: secAgo(880).toISOString(), lastHeartbeatAt: secAgo(30).toISOString(), pendingApprovals: 2,
    });
  });

  it('nulls stories progress when stories are absent or truncated, and the runner name for an unknown runner', () => {
    const v = buildDashboardView(input({ active: [dashJob({ storiesTruncated: true, stories: [] }), dashJob({ id: 'j2', runnerId: 'gone' })] }));
    expect(v.activeJobs.map((j) => [j.storiesDone, j.storiesTotal, j.runnerName])).toEqual([[null, null, 'wk-mac'], [null, null, null]]);
  });

  it('caps the lists and flags truncation', () => {
    const active = Array.from({ length: 201 }, (_, i) => dashJob({ id: `j${i}` }));
    const recentRows = Array.from({ length: 21 }, (_, i) => recent({ id: `d${i}` }));
    const v = buildDashboardView(input({ active, recent: recentRows }));
    expect([v.activeJobs.length, v.activeTruncated, v.recentJobs.length, v.recentTruncated]).toEqual([200, true, 20, true]);
    expect(buildDashboardView(input()).activeTruncated).toBe(false);
  });

  it('maps recent jobs', () => {
    expect(buildDashboardView(input()).recentJobs[0]).toEqual({
      id: 'd1', projectSlug: 'web', repo: 'acme/app', feature: 'done', command: 'RUN', state: 'COMPLETED', stateReason: null, runnerName: 'wk-mac',
      costSpentUsd: '0.1', startedAt: secAgo(4000).toISOString(), finishedAt: secAgo(3600).toISOString(), resultPrUrl: null,
    });
  });
});
