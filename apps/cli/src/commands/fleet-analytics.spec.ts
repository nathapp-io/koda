jest.mock('chalk', () => ({
  cyan: { bold: (s: string) => s }, gray: (s: string) => s, green: (s: string) => s, red: (s: string) => s, yellow: (s: string) => s,
}));
const mockStore = { get: jest.fn(() => ''), set: jest.fn() };
jest.mock('conf', () => jest.fn(() => mockStore));
jest.mock('../generated', () => ({
  projectFleetAnalyticsControllerSpend: jest.fn(),
  projectFleetAnalyticsControllerQuality: jest.fn(),
  projectFleetAnalyticsControllerStories: jest.fn(),
  projectFleetAnalyticsControllerJobs: jest.fn(),
  projectFleetAnalyticsControllerJob: jest.fn(),
  fleetAnalyticsControllerSpend: jest.fn(),
}));
jest.mock('../config', () => ({ resolveContext: jest.fn() }));

import { Command } from 'commander';
import { fleetCommand } from './fleet';
import { oneOf, pct } from './fleet-analytics';
import {
  fleetAnalyticsControllerSpend,
  projectFleetAnalyticsControllerJob,
  projectFleetAnalyticsControllerJobs,
  projectFleetAnalyticsControllerQuality,
  projectFleetAnalyticsControllerSpend,
  projectFleetAnalyticsControllerStories,
} from '../generated';
import { resolveContext } from '../config';

const CTX = { apiKey: 'jwt', apiUrl: 'https://koda.example.com', projectSlug: 'web' };
const ok = (data: unknown) => ({ ret: 0, data });
const WINDOW = { from: '2026-09-05T00:00:00.000Z', to: '2026-10-05T00:00:00.000Z' };
const spend = (over: Record<string, unknown> = {}) => ({
  window: WINDOW, bucket: 'day', groupBy: 'model',
  totals: { costUsd: '1.2346', tokens: 495, cacheShare: 0.3333, jobs: 2 },
  series: [{ key: 'm1', label: 'm1', folded: false, costUsd: '1.2346', tokens: 495, points: [] }],
  ...over,
});

describe('koda fleet analytics', () => {
  let program: Command;
  let exitSpy: jest.SpyInstance;
  let logSpy: jest.SpyInstance;
  const out = () => logSpy.mock.calls.flat().join('\n');
  const run = (...args: string[]) => program.parseAsync(['node', 'koda', 'fleet', ...args]);

  beforeEach(() => {
    program = new Command();
    program.exitOverride();
    program.configureOutput({ writeErr: () => {}, writeOut: () => {} });
    fleetCommand(program);
    (resolveContext as jest.Mock).mockResolvedValue(CTX);
    exitSpy = jest.spyOn(process, 'exit').mockImplementation((() => {}) as never);
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => jest.clearAllMocks());

  it('parses enum options and formats rates', () => {
    expect(oneOf(['day', 'week'])('week')).toBe('week');
    expect(() => oneOf(['day', 'week'])('hour')).toThrow('expected one of day, week');
    expect(pct(0.3333)).toBe('33.3%');
    expect(pct(null)).toBe('-');
  });

  it('spend uses the project route and prints totals and groups', async () => {
    (projectFleetAnalyticsControllerSpend as jest.Mock).mockResolvedValue(ok(spend()));
    await run('analytics', 'spend', '--group-by', 'story', '--bucket', 'week', '--from', '2026-09-01T00:00:00Z');
    expect(projectFleetAnalyticsControllerSpend).toHaveBeenCalledWith({
      path: { slug: 'web' }, query: { from: '2026-09-01T00:00:00Z', bucket: 'week', groupBy: 'story' },
    });
    expect(out()).toContain('Total 1.2346 USD, 495 tokens, 2 jobs, cache share 33.3%');
    expect(out()).toContain('m1');
    expect(exitSpy).toHaveBeenLastCalledWith(0);
  });

  it('spend --all-projects uses the admin route and allows --group-by project', async () => {
    (fleetAnalyticsControllerSpend as jest.Mock).mockResolvedValue(ok(spend({
      groupBy: 'project', series: [{ key: 'p1', label: 'web', folded: false, costUsd: '1.0000', tokens: 1, points: [] }],
    })));
    await run('analytics', 'spend', '--all-projects', '--group-by', 'project');
    expect(fleetAnalyticsControllerSpend).toHaveBeenCalledWith({ query: { groupBy: 'project' } });
    expect(out()).toContain('web (p1)');
  });

  it('refuses --group-by project without --all-projects, and --all-projects with --project', async () => {
    await run('analytics', 'spend', '--group-by', 'project');
    expect(projectFleetAnalyticsControllerSpend).not.toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(3);
    await run('analytics', 'spend', '--all-projects', '--project', 'web');
    expect(fleetAnalyticsControllerSpend).not.toHaveBeenCalled();
  });

  it('rejects an unknown bucket before calling the API', async () => {
    await expect(run('analytics', 'spend', '--bucket', 'hour')).rejects.toThrow();
    expect(projectFleetAnalyticsControllerSpend).not.toHaveBeenCalled();
  });

  it('says so when there is no spend, and prints JSON with --json', async () => {
    (projectFleetAnalyticsControllerSpend as jest.Mock).mockResolvedValue(ok(spend({ series: [] })));
    await run('analytics', 'spend');
    expect(out()).toContain('No spend in this window');
    logSpy.mockClear();
    await run('analytics', 'spend', '--json');
    expect(JSON.parse(out())).toMatchObject({ groupBy: 'model', series: [] });
  });

  it('quality prints rates, outcomes, reviewers and reasons', async () => {
    (projectFleetAnalyticsControllerQuality as jest.Mock).mockResolvedValue(ok({
      window: WINDOW, bucket: 'day', stories: 4, firstPassRate: 0.75, avgAttempts: 1.5,
      reviewByReviewer: [{ reviewer: 'semantic', runs: 2, passRate: 0.5, findingsBySeverity: { error: 2 } }],
      finishOutcomes: { opened: 1, promoted: 2, escalated: 1, skipped: 0, other: 0 },
      topEscalationReasons: [{ reason: 'review omitted WALK', count: 1 }], firstPassSeries: [],
    }));
    await run('analytics', 'quality', '--to', '2026-10-05T00:00:00Z');
    expect(projectFleetAnalyticsControllerQuality).toHaveBeenCalledWith({ path: { slug: 'web' }, query: { to: '2026-10-05T00:00:00Z' } });
    expect(out()).toContain('Stories 4, first pass 75.0%, average attempts 1.5');
    expect(out()).toContain('Finish: opened 1, promoted 2, escalated 1, skipped 0, other 0');
    expect(out()).toContain('error:2');
    expect(out()).toContain('review omitted WALK');
  });

  it('stories passes sort and limit; jobs prints ledger and drift', async () => {
    (projectFleetAnalyticsControllerStories as jest.Mock).mockResolvedValue(ok({ window: WINDOW, rows: [{
      jobId: 'j1', leaseEpoch: 1, featureName: 'f', storyId: 'US-1', attempts: 3, firstPassSuccess: false, success: true, costUsd: '0.3000', completedAt: null,
    }] }));
    await run('analytics', 'stories', '--sort', 'attempts', '--limit', '5');
    expect(projectFleetAnalyticsControllerStories).toHaveBeenCalledWith({ path: { slug: 'web' }, query: { sort: 'attempts', limit: 5 } });
    expect(out()).toContain('US-1');
    (projectFleetAnalyticsControllerJobs as jest.Mock).mockResolvedValue(ok({ window: WINDOW, rows: [{
      jobId: 'j1', command: 'RUN', featureName: 'f', state: 'COMPLETED', costUsd: '0.6000', ledgerCostUsd: '0.6500', driftUsd: '0.0500', finishedAt: null,
    }] }));
    await run('analytics', 'jobs');
    expect(projectFleetAnalyticsControllerJobs).toHaveBeenCalledWith({ path: { slug: 'web' }, query: {} });
    expect(out()).toContain('0.0500');
  });

  it('job analytics prints the ingest, the correction, live vs ledger and the breakdown', async () => {
    (projectFleetAnalyticsControllerJob as jest.Mock).mockResolvedValue(ok({
      jobId: 'j1', ingest: { leaseEpoch: 2, status: 'partial', files: { review: 'skipped:v3' }, ingestedAt: null, error: null },
      byStage: [{ key: 'run', costUsd: '0.4000', tokens: 10 }], byRole: [], byModel: [{ key: 'm1', costUsd: '0.4000', tokens: 10 }],
      stories: [{ leaseEpoch: 2, featureName: 'f', storyId: 'US-1', attempts: 1, firstPassSuccess: true, success: true, costUsd: '0.4000', durationMs: null, completedAt: null }],
      reviews: [{ leaseEpoch: 2, storyId: null, reviewer: 'semantic', passed: false, failOpen: false, findingCount: 1, findingsBySeverity: { error: 1 }, advisoryCount: 0, at: '2026-10-04T00:00:00.000Z' }],
      liveCostUsd: '0.3500', ledgerCostUsd: '0.4000', corrected: true,
    }));
    await run('job', 'analytics', 'j1');
    expect(projectFleetAnalyticsControllerJob).toHaveBeenCalledWith({ path: { slug: 'web', id: 'j1' } });
    expect(out()).toContain('Ingest partial (attempt 2)');
    expect(out()).toContain('review=skipped:v3');
    expect(out()).toContain('Outcome corrected from finish-audit');
    expect(out()).toContain('Live 0.3500 USD / ledger 0.4000 USD');
    expect(out()).toContain('run');
    expect(out()).toContain('US-1');
    expect(out()).toContain('semantic');
    expect(out()).toContain('error:1');
  });

  it('job analytics says when nothing is analysed yet', async () => {
    (projectFleetAnalyticsControllerJob as jest.Mock).mockResolvedValue(ok({
      jobId: 'j1', ingest: null, byStage: [], byRole: [], byModel: [], stories: [], reviews: [], liveCostUsd: null, ledgerCostUsd: null, corrected: false,
    }));
    await run('job', 'analytics', 'j1');
    expect(out()).toContain('Not analysed yet');
  });
});
