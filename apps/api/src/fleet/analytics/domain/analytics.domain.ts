import type { Prisma } from '@prisma/client';

export type Bucket = 'day' | 'week' | 'month';
export const BUCKETS: readonly Bucket[] = ['day', 'week', 'month'];

export type ProjectGroupBy = 'model' | 'stage' | 'role' | 'repo' | 'runner' | 'feature' | 'story';
export const PROJECT_GROUPS: readonly ProjectGroupBy[] = ['model', 'stage', 'role', 'repo', 'runner', 'feature', 'story'];
export type GroupBy = ProjectGroupBy | 'project';
export const ADMIN_GROUPS: readonly GroupBy[] = [...PROJECT_GROUPS, 'project'];

export type StorySort = 'cost' | 'attempts';
export const STORY_SORTS: readonly StorySort[] = ['cost', 'attempts'];
export type JobSort = 'cost';
export const JOB_SORTS: readonly JobSort[] = ['cost'];
export type JobSliceBy = 'stage' | 'role' | 'model';

/** Spec §4.1-4.2 and D383. */
export const ANALYTICS_LIMITS = {
  defaultWindowDays: 30,
  maxWindowDays: 366,
  dayBucketMaxDays: 31,
  weekBucketMaxDays: 182,
  seriesKeep: 12,
  listDefault: 20,
  listMax: 50,
  topReasons: 10,
  reasonText: 200,
  jobDetailRows: 500,
} as const;

/** D377: the key of a null dimension (role, runner, story). */
export const NONE_KEY = '(none)';
/** D377: the key of the folded series. */
export const OTHER_KEY = 'other';

/** Half-open [from, to) (D378). */
export interface AnalyticsWindow {
  from: Date;
  to: Date;
  bucket: Bucket;
}

/** One (key, bucket) spend cell; money stays unrounded until the response (A7). */
export interface SpendCell {
  key: string;
  t: Date;
  costUsd: Prisma.Decimal;
  tokens: number;
}
