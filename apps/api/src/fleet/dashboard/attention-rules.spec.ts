import { DASH_NOW, DASH_THRESHOLDS, dashCaps, dashJob, dashRunner, secAgo } from '../../common/test-helpers/fleet-dashboard';
import { AttentionInput, buildAttention, forProjectScope, sortAttention } from './attention-rules';
import type { AttentionItem } from './dashboard.types';

const NO_PAUSE = { runnerPaused: () => false, match: () => null };
const broken = dashCaps({ nax: { version: '0.82.0', protocols: ['native'] }, credentials: [{ providerId: 'deepseek', available: false, stored: null, ambient: false }] });

/** web job j1 RUNNING on an offline runner r2 (silent), ops QUEUED job j9 with no fitting runner, r3 newer nax. */
const input = (scope: AttentionInput['scope']): AttentionInput => ({
  scope,
  runners: [
    dashRunner({ id: 'r2', name: 'old-box', lastSeenAt: secAgo(500), capabilities: broken }),
    dashRunner({ id: 'r3', name: 'new-box', labels: ['linux'] }),
  ],
  heldByRunner: new Map([['r2', 1]]),
  activeJobs: scope.kind === 'global'
    ? [dashJob({ runnerId: 'r2', lastHeartbeatAt: secAgo(900) })]
    : [dashJob({ runnerId: 'r2', lastHeartbeatAt: secAgo(900) })].filter((j) => j.projectId === scope.projectId),
  pending: new Map(),
  dryRun: {
    queued: [dashJob({ id: 'j9', projectId: 'p2', projectSlug: 'ops', feature: 'secret-feature', state: 'QUEUED', runnerId: null, queuedAt: secAgo(300), selectorLabels: ['gpu'] })],
    loads: new Map([['r2', { active: 1, repoIds: new Set(['repo1']) }]]),
    pauses: NO_PAUSE,
  },
});

describe('buildAttention (S2b (c) §2)', () => {
  it('global scope: one runner item for the offline runner (no job_silent), the foreign queued job, full conditions', () => {
    const items = buildAttention(input({ kind: 'global' }), DASH_NOW, DASH_THRESHOLDS);
    expect(items.map((i) => i.key)).toEqual(['runner_unhealthy:r2', 'job_unplaceable:j9']);
    expect(items[0]).toMatchObject({ severity: 'error' });
    expect(items[0].conditions).toEqual([
      { type: 'offline', jobsHeld: 1 },
      { type: 'credential', providerId: 'deepseek', why: 'unavailable' },
      { type: 'stale_nax', version: '0.82.0', latest: '0.83.3' },
    ]);
  });

  it('project scope: drops other projects\' queued jobs and collapses runner detail to configuration', () => {
    const items = buildAttention(input({ kind: 'project', projectId: 'p1' }), DASH_NOW, DASH_THRESHOLDS);
    expect(items.map((i) => i.key)).toEqual(['runner_unhealthy:r2']);
    expect(items[0].conditions).toEqual([{ type: 'offline', jobsHeld: 1 }, { type: 'configuration' }]);
    const json = JSON.stringify(items);
    for (const leak of ['secret-feature', 'j9', 'ops', 'deepseek', '0.82.0', '0.83.3']) expect(json).not.toContain(leak);
  });
});

describe('forProjectScope', () => {
  const runnerItem = (conditions: AttentionItem['conditions'], severity: AttentionItem['severity'] = 'error'): AttentionItem => ({
    key: 'runner_unhealthy:r1', kind: 'runner_unhealthy', severity, subjectType: 'runner', subjectId: 'r1', subjectName: 'wk-mac',
    projectSlug: null, since: null, conditions,
  });

  it('keeps an error only for an offline runner holding jobs', () => {
    expect(forProjectScope(runnerItem([{ type: 'credential', providerId: 'x', why: 'missing' }]))).toMatchObject({
      severity: 'warning', conditions: [{ type: 'configuration' }],
    });
    expect(forProjectScope(runnerItem([{ type: 'offline', jobsHeld: 1 }])).severity).toBe('error');
  });

  it('leaves job items untouched', () => {
    const job: AttentionItem = { ...runnerItem(undefined), key: 'job_silent:j1', kind: 'job_silent', subjectType: 'job' };
    expect(forProjectScope(job)).toBe(job);
  });
});

describe('sortAttention', () => {
  it('orders errors first, then oldest since (unknown last), then key', () => {
    const item = (key: string, severity: AttentionItem['severity'], since: string | null): AttentionItem => ({
      key, kind: 'job_silent', severity, subjectType: 'job', subjectId: key, subjectName: key, projectSlug: 'web', since,
    });
    const sorted = sortAttention([
      item('w-new', 'warning', '2026-10-05T11:00:00.000Z'), item('e-null', 'error', null), item('e-old', 'error', '2026-10-05T10:00:00.000Z'),
      item('w-old-b', 'warning', '2026-10-05T09:00:00.000Z'), item('w-old-a', 'warning', '2026-10-05T09:00:00.000Z'),
    ]);
    expect(sorted.map((i) => i.key)).toEqual(['e-old', 'e-null', 'w-old-a', 'w-old-b', 'w-new']);
  });
});
