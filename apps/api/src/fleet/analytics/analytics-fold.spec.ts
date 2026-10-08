import { Prisma } from '../../generated/prisma/client';
import { foldSeries } from './analytics-fold';
import type { SpendCell } from './domain/analytics.domain';

const cell = (key: string, t: string, cost: string, tokens = 1): SpendCell => ({ key, t: new Date(t), costUsd: new Prisma.Decimal(cost), tokens });
const starts = [new Date('2026-10-01T00:00:00Z'), new Date('2026-10-02T00:00:00Z')];

describe('foldSeries', () => {
  it('zero-fills every bucket and sums before rounding', () => {
    const cells = [1, 2, 3].map(() => cell('m', '2026-10-01T00:00:00Z', '0.00004'));
    expect(foldSeries(cells, starts, new Map())).toEqual([{
      key: 'm', label: 'm', folded: false, costUsd: '0.0001', tokens: 3,
      points: [
        { t: '2026-10-01T00:00:00.000Z', costUsd: '0.0001', tokens: 3 },
        { t: '2026-10-02T00:00:00.000Z', costUsd: '0.0000', tokens: 0 },
      ],
    }]);
  });

  it('keeps the top 12 keys by cost, labelled, and folds the rest into other', () => {
    const cells = Array.from({ length: 14 }, (_, i) => cell(`k${String(i).padStart(2, '0')}`, '2026-10-02T00:00:00Z', String(14 - i)));
    const series = foldSeries(cells, starts, new Map([['k00', 'Label zero']]));
    expect(series).toHaveLength(13);
    expect(series[0]).toMatchObject({ key: 'k00', label: 'Label zero', folded: false, costUsd: '14.0000' });
    expect(series[12]).toMatchObject({ key: 'other', label: 'other', folded: true, costUsd: '3.0000', tokens: 2 });
  });

  it('keeps a real key named other distinct from the fold', () => {
    const cells = [cell('other', '2026-10-01T00:00:00Z', '1')];
    expect(foldSeries(cells, starts, new Map(), 1)).toEqual([expect.objectContaining({ key: 'other', folded: false })]);
  });

  it('breaks cost ties by key and returns no series without cells', () => {
    const cells = [cell('b', '2026-10-01T00:00:00Z', '1'), cell('a', '2026-10-01T00:00:00Z', '1')];
    expect(foldSeries(cells, starts, new Map()).map((s) => s.key)).toEqual(['a', 'b']);
    expect(foldSeries([], starts, new Map())).toEqual([]);
  });
});
