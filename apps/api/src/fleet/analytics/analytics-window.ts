import { ValidationAppException } from '@nathapp/nestjs-common';
import { Prisma } from '@prisma/client';
import { ANALYTICS_LIMITS, AnalyticsWindow, Bucket } from './domain/analytics.domain';

const DAY_MS = 86_400_000;

/** D385: cross-field query errors; single fields are validated by the DTOs. */
export function invalidAnalytics(reason: string): ValidationAppException {
  return new ValidationAppException({ reason }, 'fleet.analyticsQuery');
}

/** Spec §4.1: <= 31 days day, <= 182 days week, else month. */
export function defaultBucket(spanMs: number): Bucket {
  if (spanMs <= ANALYTICS_LIMITS.dayBucketMaxDays * DAY_MS) return 'day';
  if (spanMs <= ANALYTICS_LIMITS.weekBucketMaxDays * DAY_MS) return 'week';
  return 'month';
}

/** Spec §4.1, D378: default the 30 days ending now; half-open [from, to); at most 366 days. */
export function resolveWindow(q: { from?: string; to?: string; bucket?: Bucket }, now: Date): AnalyticsWindow {
  const to = q.to ? new Date(q.to) : now;
  const from = q.from ? new Date(q.from) : new Date(to.getTime() - ANALYTICS_LIMITS.defaultWindowDays * DAY_MS);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) throw invalidAnalytics('from and to must be ISO 8601 instants');
  const span = to.getTime() - from.getTime();
  if (span <= 0) throw invalidAnalytics('from must be before to');
  if (span > ANALYTICS_LIMITS.maxWindowDays * DAY_MS) throw invalidAnalytics(`the window is longer than ${ANALYTICS_LIMITS.maxWindowDays} days`);
  return { from, to, bucket: q.bucket ?? defaultBucket(span) };
}

/** UTC start of the bucket holding `at`; weeks start Monday, as Postgres date_trunc. */
export function bucketStart(at: Date, bucket: Bucket): Date {
  const y = at.getUTCFullYear();
  const m = at.getUTCMonth();
  const d = at.getUTCDate();
  if (bucket === 'month') return new Date(Date.UTC(y, m, 1));
  if (bucket === 'day') return new Date(Date.UTC(y, m, d));
  const sinceMonday = (at.getUTCDay() + 6) % 7;
  return new Date(Date.UTC(y, m, d - sinceMonday));
}

function nextBucket(t: Date, bucket: Bucket): Date {
  if (bucket === 'month') return new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 1));
  return new Date(t.getTime() + (bucket === 'week' ? 7 : 1) * DAY_MS);
}

/** D378: every bucket start overlapping [from, to), ascending. */
export function bucketStarts(w: AnalyticsWindow): Date[] {
  const starts: Date[] = [];
  for (let t = bucketStart(w.from, w.bucket); t.getTime() < w.to.getTime(); t = nextBucket(t, w.bucket)) starts.push(t);
  return starts;
}

type Money = Prisma.Decimal | string | number;

/** A7: four places, half-up, applied once to an unrounded value. */
export const usd4 = (v: Money | null): string =>
  new Prisma.Decimal(v ?? 0).toDecimalPlaces(4, Prisma.Decimal.ROUND_HALF_UP).toFixed(4);

export const usd4OrNull = (v: Money | null): string | null => (v === null ? null : usd4(v));

/** D388: the median of unrounded values (the mean of the middle two for an even count); null with none. */
export function medianMoney(values: readonly Prisma.Decimal[]): Prisma.Decimal | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a.cmp(b));
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : sorted[mid - 1].add(sorted[mid]).div(2);
}

/** D380: a four-place ratio, null when there is nothing to divide by. */
export const rate4 = (part: number, whole: number): number | null =>
  whole === 0 ? null : Math.round((part / whole) * 10_000) / 10_000;

/** Spec §4.2: the first non-empty line, trimmed, at most 200 characters. */
export function normaliseReason(raw: string): string {
  const line = raw.split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0) ?? '';
  return line.slice(0, ANALYTICS_LIMITS.reasonText);
}
