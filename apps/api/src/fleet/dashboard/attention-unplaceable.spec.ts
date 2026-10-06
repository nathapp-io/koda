import { DASH_NOW, DASH_THRESHOLDS, dashCaps, dashJob, dashRunner, secAgo } from '../../common/test-helpers/fleet-dashboard';
import type { RunnerLoad } from '../jobs/placement-rules';
import { DryRunInput, jobUnplaceableItems } from './attention-unplaceable';

const QUEUED = dashJob({ state: 'QUEUED', runnerId: null, assignedAt: null, startedAt: null, lastHeartbeatAt: null, queuedAt: secAgo(120) });
const NO_PAUSE = { runnerPaused: () => false, match: () => null };
const input = (over: Partial<DryRunInput> = {}): DryRunInput => ({
  queued: [QUEUED], runners: [dashRunner()], loads: new Map<string, RunnerLoad>(), pauses: NO_PAUSE, ...over,
});
const run = (over: Partial<DryRunInput> = {}) => jobUnplaceableItems(input(over), DASH_NOW, DASH_THRESHOLDS);
const only = (over: Partial<DryRunInput> = {}) => {
  const { items } = run(over);
  expect(items).toHaveLength(1);
  return items[0];
};

describe('job_unplaceable (S2b (c) §2.3)', () => {
  it('ignores a job younger than FLEET_JOB_QUEUED_WARN_SEC and a job of a soft-deleted project', () => {
    expect(run({ queued: [{ ...QUEUED, queuedAt: secAgo(59) }] }).items).toEqual([]);
    expect(run({ queued: [{ ...QUEUED, projectDeleted: true }], runners: [] }).items).toEqual([]);
  });

  it('reports fits_not_placed when a runner fits (placement is not reaching the job)', () => {
    expect(only()).toEqual({
      projectId: 'p1',
      item: {
        key: 'job_unplaceable:j1', kind: 'job_unplaceable', severity: 'warning', subjectType: 'job', subjectId: 'j1', subjectName: 'add-auth',
        projectSlug: 'web', since: secAgo(120).toISOString(), verdict: 'fits_not_placed', reasons: [], reasonsTotal: 0,
      },
    });
  });

  it('reports budget_paused when the job scope itself is paused (placement will cancel it)', () => {
    const pauses = { runnerPaused: () => false, match: (keys: readonly string[]) => (keys.includes('project:p1') ? { id: 'b1' } : null) };
    expect(only({ pauses }).item).toMatchObject({ verdict: 'budget_paused', severity: 'warning', reasons: [], reasonsTotal: 0 });
  });

  it('reports no_runners (error) with no readable candidate', () => {
    expect(only({ runners: [] }).item).toMatchObject({ verdict: 'no_runners', severity: 'error' });
    expect(only({ runners: [dashRunner({ capabilities: null })] }).item).toMatchObject({ verdict: 'no_runners', severity: 'error' });
  });

  it('reports never (error) when every misfit is permanent', () => {
    expect(only({ runners: [dashRunner({ enabled: false })] }).item).toMatchObject({
      verdict: 'never', severity: 'error', reasons: [{ runnerName: 'wk-mac', reason: 'disabled' }], reasonsTotal: 1,
    });
  });

  it('reports waiting_capacity (warning) when every runner is busy', () => {
    const loads = new Map([['r1', { active: 1, repoIds: new Set(['other']) }]]);
    expect(only({ loads }).item).toMatchObject({ verdict: 'waiting_capacity', severity: 'warning', reasons: [{ runnerName: 'wk-mac', reason: 'capacity' }] });
  });

  it('reports runners_paused when every runner is budget-paused', () => {
    expect(only({ pauses: { runnerPaused: () => true, match: () => null } }).item).toMatchObject({ verdict: 'runners_paused', severity: 'warning' });
  });

  it('reports no_fit for any other mix, reasons sorted by runner name', () => {
    const runners = [dashRunner({ id: 'r2', name: 'zz-box', lastSeenAt: secAgo(500) }), dashRunner({ id: 'r1', name: 'aa-box', labels: ['mac'] })];
    const item = only({ runners, queued: [{ ...QUEUED, selectorLabels: ['gpu'] }] }).item;
    expect(item).toMatchObject({ verdict: 'no_fit', severity: 'warning', reasonsTotal: 2 });
    expect(item.reasons).toEqual([{ runnerName: 'aa-box', reason: 'labels' }, { runnerName: 'zz-box', reason: 'offline' }]);
  });

  it('evaluates only the pinned runner for a pinned job', () => {
    const runners = [dashRunner({ id: 'r1', name: 'free', capacity: 4 }), dashRunner({ id: 'r2', name: 'pinned', lastSeenAt: secAgo(500) })];
    const item = only({ runners, queued: [{ ...QUEUED, pinnedRunnerId: 'r2' }] }).item;
    expect(item).toMatchObject({ verdict: 'no_fit', reasons: [{ runnerName: 'pinned', reason: 'offline' }], reasonsTotal: 1 });
  });

  it('caps reasons at 20 and reports the total', () => {
    const runners = Array.from({ length: 25 }, (_, i) => dashRunner({ id: `r${i}`, name: `box-${String(i).padStart(2, '0')}`, enabled: false }));
    const item = only({ runners }).item;
    expect(item.reasons).toHaveLength(20);
    expect(item.reasonsTotal).toBe(25);
    expect(item.reasons?.[0].runnerName).toBe('box-00');
  });

  it('collects runners that block an unplaced job on something the runner can fix (credential or interaction)', () => {
    const broken = dashCaps({ credentials: [{ providerId: 'deepseek', available: false, stored: null, ambient: false }] });
    const { fixableBlockedRunnerIds } = run({ runners: [dashRunner({ capabilities: broken })] });
    expect([...fixableBlockedRunnerIds]).toEqual(['r1']);
    expect([...run().fixableBlockedRunnerIds]).toEqual([]);
  });

  it('#207: a no-profile job on a runner whose base config cannot start its plugin is no_fit on interaction', () => {
    const tg = dashCaps({ interaction: { ok: false, plugin: 'telegram', code: 'TELEGRAM_NOT_CONFIGURED' } });
    const result = run({ queued: [{ ...QUEUED, profiles: [] }], runners: [dashRunner({ capabilities: tg })] });
    expect(result.items[0]?.item).toMatchObject({ verdict: 'no_fit', severity: 'warning', reasons: [{ runnerName: 'wk-mac', reason: 'interaction' }] });
    expect([...result.fixableBlockedRunnerIds]).toEqual(['r1']);
  });
});
