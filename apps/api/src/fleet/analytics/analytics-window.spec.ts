import { ValidationAppException } from '@nathapp/nestjs-common';
import { Prisma } from '@prisma/client';
import { bucketStart, bucketStarts, defaultBucket, medianMoney, normaliseReason, rate4, resolveWindow, usd4, usd4OrNull } from './analytics-window';

const DAY = 86_400_000;
const now = new Date('2026-10-05T12:00:00.000Z');

describe('resolveWindow', () => {
  it('defaults to the 30 days ending now, bucketed by day', () => {
    expect(resolveWindow({}, now)).toEqual({ from: new Date(now.getTime() - 30 * DAY), to: now, bucket: 'day' });
  });

  it('keeps an explicit window and bucket', () => {
    expect(resolveWindow({ from: '2026-01-01', to: '2026-10-01', bucket: 'day' }, now)).toEqual({
      from: new Date('2026-01-01T00:00:00.000Z'), to: new Date('2026-10-01T00:00:00.000Z'), bucket: 'day',
    });
  });

  it('defaults the bucket from the window length', () => {
    expect(defaultBucket(31 * DAY)).toBe('day');
    expect(defaultBucket(31 * DAY + 1)).toBe('week');
    expect(defaultBucket(182 * DAY)).toBe('week');
    expect(defaultBucket(182 * DAY + 1)).toBe('month');
  });

  it('rejects an empty or reversed window and one longer than 366 days', () => {
    expect(() => resolveWindow({ from: '2026-10-01', to: '2026-10-01' }, now)).toThrow(ValidationAppException);
    expect(() => resolveWindow({ from: '2026-10-02', to: '2026-10-01' }, now)).toThrow(ValidationAppException);
    expect(() => resolveWindow({ from: '2025-01-01', to: '2026-01-03' }, now)).toThrow(ValidationAppException);
    expect(resolveWindow({ from: '2025-01-01', to: '2026-01-02' }, now).bucket).toBe('month'); // exactly 366 days
  });
});

describe('buckets', () => {
  it('truncates in UTC and starts weeks on Monday', () => {
    const sunday = new Date('2026-10-04T23:59:59.999Z');
    expect(bucketStart(sunday, 'week').toISOString()).toBe('2026-09-28T00:00:00.000Z');
    expect(bucketStart(new Date('2026-10-05T00:00:00.000Z'), 'week').toISOString()).toBe('2026-10-05T00:00:00.000Z');
    expect(bucketStart(sunday, 'day').toISOString()).toBe('2026-10-04T00:00:00.000Z');
    expect(bucketStart(sunday, 'month').toISOString()).toBe('2026-10-01T00:00:00.000Z');
  });

  it('lists every bucket that overlaps the half-open window', () => {
    const days = bucketStarts({ from: new Date('2026-09-30T12:00:00Z'), to: new Date('2026-10-02T00:00:00Z'), bucket: 'day' });
    expect(days.map((d) => d.toISOString())).toEqual(['2026-09-30T00:00:00.000Z', '2026-10-01T00:00:00.000Z']);
    const months = bucketStarts({ from: new Date('2025-12-15T00:00:00Z'), to: new Date('2026-02-01T00:00:00Z'), bucket: 'month' });
    expect(months.map((d) => d.toISOString())).toEqual(['2025-12-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z']);
  });
});

describe('money, rates and reasons', () => {
  it('rounds money half-up to exactly four places', () => {
    expect(usd4(new Prisma.Decimal('0.00005'))).toBe('0.0001');
    expect(usd4(new Prisma.Decimal('0.00004999'))).toBe('0.0000');
    expect(usd4('12.3')).toBe('12.3000');
    expect(usd4(null)).toBe('0.0000');
    expect(usd4OrNull(null)).toBeNull();
  });

  it('rounds rates to four places and returns null without a denominator', () => {
    expect(rate4(1, 3)).toBe(0.3333);
    expect(rate4(2, 3)).toBe(0.6667);
    expect(rate4(0, 0)).toBeNull();
  });

  it('normalises an escalation reason to its first non-empty line, at most 200 characters', () => {
    expect(normaliseReason('\n  quality review omitted ## WALK  \nmore detail')).toBe('quality review omitted ## WALK');
    expect(normaliseReason('x'.repeat(300))).toHaveLength(200);
    expect(normaliseReason('   ')).toBe('');
  });
});

describe('medianMoney', () => {
  const D = (v: string) => new Prisma.Decimal(v);

  it('is null without values', () => {
    expect(medianMoney([])).toBeNull();
  });

  it('takes the middle value of an odd count, whatever the input order', () => {
    expect(medianMoney([D('3'), D('0.00001'), D('2')])?.toFixed(8)).toBe('2.00000000');
  });

  it('averages the middle two of an even count without rounding', () => {
    expect(medianMoney([D('0.00001'), D('0.00002')])?.toFixed(8)).toBe('0.00001500');
  });

  it('does not reorder its input', () => {
    const input = [D('2'), D('1')];
    medianMoney(input);
    expect(input.map((d) => d.toFixed(0))).toEqual(['2', '1']);
  });
});
