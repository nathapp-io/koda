import { finishOutcomes, firstPassSeries, reviewerViews, topReasons } from './analytics-quality';

describe('quality mapping', () => {
  it('buckets finish results, with unknown and prototype-named values as other (D381)', () => {
    expect(finishOutcomes([
      { value: 'opened', count: 2 }, { value: 'promoted', count: 1 }, { value: 'already-ready', count: 1 },
      { value: 'escalated', count: 3 }, { value: 'skipped', count: 1 }, { value: 'nothing-to-finish', count: 1 },
      { value: 'constructor', count: 1 }, { value: 'weird', count: 2 },
    ])).toEqual({ opened: 2, promoted: 2, escalated: 3, skipped: 2, other: 3 });
    expect(finishOutcomes([])).toEqual({ opened: 0, promoted: 0, escalated: 0, skipped: 0, other: 0 });
  });

  it('merges escalation reasons by their first line, drops empty ones, sorts and limits', () => {
    expect(topReasons([
      { value: 'review omitted WALK\nfile a', count: 2 }, { value: 'review omitted WALK\nfile b', count: 1 },
      { value: 'tests failed', count: 3 }, { value: '  \n ', count: 5 }, { value: 'budget', count: 1 },
    ], 2)).toEqual([{ reason: 'review omitted WALK', count: 3 }, { reason: 'tests failed', count: 3 }]);
  });

  it('builds reviewer views with pass rates and their severity counts', () => {
    expect(reviewerViews(
      [{ reviewer: 'semantic', runs: 2, passed: 1 }, { reviewer: 'lint', runs: 1, passed: 1 }],
      [{ reviewer: 'semantic', severity: 'error', count: 2 }],
    )).toEqual([
      { reviewer: 'semantic', runs: 2, passRate: 0.5, findingsBySeverity: { error: 2 } },
      { reviewer: 'lint', runs: 1, passRate: 1, findingsBySeverity: {} },
    ]);
  });

  it('zero-fills the first-pass series with null rates', () => {
    const starts = [new Date('2026-10-01T00:00:00Z'), new Date('2026-10-02T00:00:00Z')];
    expect(firstPassSeries([{ t: new Date('2026-10-02T00:00:00Z'), stories: 3, firstPass: 2 }], starts)).toEqual([
      { t: '2026-10-01T00:00:00.000Z', rate: null },
      { t: '2026-10-02T00:00:00.000Z', rate: 0.6667 },
    ]);
  });
});
