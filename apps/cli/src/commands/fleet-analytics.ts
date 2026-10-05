import { Command, InvalidArgumentError } from 'commander';
import {
  fleetAnalyticsControllerSpend,
  projectFleetAnalyticsControllerJob,
  projectFleetAnalyticsControllerJobs,
  projectFleetAnalyticsControllerQuality,
  projectFleetAnalyticsControllerSpend,
  projectFleetAnalyticsControllerStories,
  type CostSliceDto,
  type JobAnalyticsDto,
  type JobsAnalyticsDto,
  type QualityAnalyticsDto,
  type SpendAnalyticsDto,
  type StoriesAnalyticsDto,
} from '../generated';
import { unwrap } from '../utils/api';
import { withContext } from '../utils/context';
import { handleApiError } from '../utils/error';
import { table } from '../utils/output';
import { parsePositiveInt } from '../utils/parse-positive-int';
import { ADMIN_TOKEN_HINT, ago, handleFleetValidation } from './fleet-shared';

const BUCKETS = ['day', 'week', 'month'] as const;
const PROJECT_GROUPS = ['model', 'stage', 'role', 'repo', 'runner', 'feature', 'story'] as const;
const ADMIN_GROUPS = [...PROJECT_GROUPS, 'project'] as const;
const STORY_SORTS = ['cost', 'attempts'] as const;

type Bucket = (typeof BUCKETS)[number];
type AdminGroup = (typeof ADMIN_GROUPS)[number];
type ProjectGroup = (typeof PROJECT_GROUPS)[number];
type StorySort = (typeof STORY_SORTS)[number];

/** Commander value parser for a fixed set of values. */
export function oneOf<T extends string>(values: readonly T[]): (value: string) => T {
  return (value: string) => {
    if (!(values as readonly string[]).includes(value)) throw new InvalidArgumentError(`expected one of ${values.join(', ')}`);
    return value as T;
  };
}

/** A 0..1 rate as a percentage with one decimal; '-' when there is no data (D380). */
export const pct = (rate: number | null | undefined): string => (rate === null || rate === undefined ? '-' : `${(rate * 100).toFixed(1)}%`);

const yesNo = (v: boolean): string => (v ? 'yes' : 'no');
const countsText = (m: Record<string, number>): string => Object.entries(m).map(([k, v]) => `${k}:${v}`).join(' ') || '-';
const filesText = (m: Record<string, string>): string => Object.entries(m).map(([k, v]) => `${k}=${v}`).join(' ') || '-';

interface WindowOptions { from?: string; to?: string; project?: string; json?: boolean }
interface SpendOptions extends WindowOptions { bucket?: Bucket; groupBy?: string; allProjects?: boolean }
interface ListOptions extends WindowOptions { limit?: number }
interface StoriesOptions extends ListOptions { sort?: StorySort }

const windowQuery = (o: WindowOptions): { from?: string; to?: string } => ({
  ...(o.from ? { from: o.from } : {}), ...(o.to ? { to: o.to } : {}),
});

function withWindowOptions(cmd: Command): Command {
  return cmd
    .option('--from <iso>', 'Window start, inclusive (UTC); default 30 days before --to')
    .option('--to <iso>', 'Window end, exclusive (UTC); default now')
    .option('--project <slug>', 'Project slug (uses config if not provided)')
    .option('--json', 'Output as JSON');
}

function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

function printSpend(s: SpendAnalyticsDto): void {
  console.log(`Spend ${s.window.from} .. ${s.window.to} by ${s.groupBy} (${s.bucket})`);
  console.log(`Total ${s.totals.costUsd} USD, ${s.totals.tokens} tokens, ${s.totals.jobs} jobs, cache share ${pct(s.totals.cacheShare)}`);
  if (s.series.length === 0) {
    console.log('No spend in this window');
    return;
  }
  table(['Group', 'Cost (USD)', 'Tokens'], s.series.map((x) => [x.label === x.key ? x.key : `${x.label} (${x.key})`, x.costUsd, String(x.tokens)]));
}

/** `groupBy` was checked against the allowed list in the action, so the narrowing casts are safe. */
async function fetchSpend(o: SpendOptions): Promise<SpendAnalyticsDto> {
  const base = { ...windowQuery(o), ...(o.bucket ? { bucket: o.bucket } : {}) };
  if (o.allProjects) {
    await withContext({}, { requireProject: false });
    const query = { ...base, ...(o.groupBy ? { groupBy: o.groupBy as AdminGroup } : {}) };
    return unwrap<SpendAnalyticsDto>(await fleetAnalyticsControllerSpend({ query }));
  }
  const { projectSlug: slug } = await withContext({ projectSlug: o.project });
  const query = { ...base, ...(o.groupBy ? { groupBy: o.groupBy as ProjectGroup } : {}) };
  return unwrap<SpendAnalyticsDto>(await projectFleetAnalyticsControllerSpend({ path: { slug }, query }));
}

function registerSpend(analytics: Command): void {
  withWindowOptions(analytics.command('spend'))
    .description('Fleet spend over a window, grouped by model, stage, role, repo, runner, feature or story')
    .option('--bucket <bucket>', 'day, week or month (default from the window length)', oneOf(BUCKETS))
    .option('--group-by <dimension>', `${PROJECT_GROUPS.join(', ')} (default model); project with --all-projects`)
    .option('--all-projects', 'Across every project (global admin)')
    .action(async (o: SpendOptions) => {
      const groups: readonly string[] = o.allProjects ? ADMIN_GROUPS : PROJECT_GROUPS;
      if (o.allProjects && o.project) return handleFleetValidation('--all-projects and --project cannot be combined');
      if (o.groupBy && !groups.includes(o.groupBy)) return handleFleetValidation(`Unknown --group-by "${o.groupBy}": ${groups.join(', ')}`);
      try {
        const s = await fetchSpend(o);
        if (o.json) printJson(s);
        else printSpend(s);
        process.exit(0);
      } catch (err: unknown) {
        handleApiError(err, o.allProjects ? { forbiddenHint: ADMIN_TOKEN_HINT } : undefined);
      }
    });
}

function printQuality(q: QualityAnalyticsDto): void {
  console.log(`Quality ${q.window.from} .. ${q.window.to}`);
  console.log(`Stories ${q.stories}, first pass ${pct(q.firstPassRate)}, average attempts ${q.avgAttempts ?? '-'}`);
  const f = q.finishOutcomes;
  console.log(`Finish: opened ${f.opened}, promoted ${f.promoted}, escalated ${f.escalated}, skipped ${f.skipped}, other ${f.other}`);
  if (q.reviewByReviewer.length > 0) {
    table(['Reviewer', 'Runs', 'Pass rate', 'Findings'], q.reviewByReviewer.map((r) => [r.reviewer, String(r.runs), pct(r.passRate), countsText(r.findingsBySeverity)]));
  }
  if (q.topEscalationReasons.length > 0) {
    table(['Escalation reason', 'Count'], q.topEscalationReasons.map((r) => [r.reason, String(r.count)]));
  }
}

function registerQuality(analytics: Command): void {
  withWindowOptions(analytics.command('quality'))
    .description('Run quality over a window: first pass, attempts, reviews, finish outcomes, escalation reasons')
    .option('--bucket <bucket>', 'day, week or month (default from the window length)', oneOf(BUCKETS))
    .action(async (o: WindowOptions & { bucket?: Bucket }) => {
      try {
        const { projectSlug: slug } = await withContext({ projectSlug: o.project });
        const q = unwrap<QualityAnalyticsDto>(await projectFleetAnalyticsControllerQuality({
          path: { slug }, query: { ...windowQuery(o), ...(o.bucket ? { bucket: o.bucket } : {}) },
        }));
        if (o.json) printJson(q);
        else printQuality(q);
        process.exit(0);
      } catch (err: unknown) {
        handleApiError(err);
      }
    });
}

function registerStories(analytics: Command): void {
  withWindowOptions(analytics.command('stories'))
    .description('The most expensive (or most looping) stories completed in a window')
    .option('--sort <sort>', 'cost or attempts (default cost)', oneOf(STORY_SORTS))
    .option('--limit <n>', 'Rows, 1-50 (default 20)', parsePositiveInt)
    .action(async (o: StoriesOptions) => {
      try {
        const { projectSlug: slug } = await withContext({ projectSlug: o.project });
        const page = unwrap<StoriesAnalyticsDto>(await projectFleetAnalyticsControllerStories({
          path: { slug }, query: { ...windowQuery(o), ...(o.sort ? { sort: o.sort } : {}), ...(o.limit ? { limit: o.limit } : {}) },
        }));
        if (o.json) {
          printJson(page);
        } else {
          table(['Job', 'Feature', 'Story', 'Attempts', 'First pass', 'Success', 'Cost (USD)', 'Completed'], page.rows.map((r) => [
            r.jobId, r.featureName, r.storyId, String(r.attempts), yesNo(r.firstPassSuccess), yesNo(r.success), r.costUsd, ago(r.completedAt),
          ]));
        }
        process.exit(0);
      } catch (err: unknown) {
        handleApiError(err);
      }
    });
}

function registerJobs(analytics: Command): void {
  withWindowOptions(analytics.command('jobs'))
    .description('The most expensive jobs finished in a window, with cost-ledger drift')
    .option('--limit <n>', 'Rows, 1-50 (default 20)', parsePositiveInt)
    .action(async (o: ListOptions) => {
      try {
        const { projectSlug: slug } = await withContext({ projectSlug: o.project });
        const page = unwrap<JobsAnalyticsDto>(await projectFleetAnalyticsControllerJobs({
          path: { slug }, query: { ...windowQuery(o), ...(o.limit ? { limit: o.limit } : {}) },
        }));
        if (o.json) {
          printJson(page);
        } else {
          table(['Job', 'Cmd', 'Feature', 'State', 'Cost (USD)', 'Ledger', 'Drift', 'Finished'], page.rows.map((r) => [
            r.jobId, r.command, r.featureName, r.state, r.costUsd, r.ledgerCostUsd ?? '-', r.driftUsd ?? '-', ago(r.finishedAt),
          ]));
        }
        process.exit(0);
      } catch (err: unknown) {
        handleApiError(err);
      }
    });
}

export function registerFleetAnalytics(fleet: Command): void {
  const analytics = fleet.command('analytics');
  analytics.description('Fleet cost and run-quality analytics (S2b): spend, quality, stories, jobs');
  registerSpend(analytics);
  registerQuality(analytics);
  registerStories(analytics);
  registerJobs(analytics);
}

function printSlices(title: string, slices: CostSliceDto[]): void {
  if (slices.length > 0) table([title, 'Cost (USD)', 'Tokens'], slices.map((s) => [s.key, s.costUsd, String(s.tokens)]));
}

function printJobAnalytics(j: JobAnalyticsDto): void {
  if (j.ingest) {
    console.log(`Ingest ${j.ingest.status} (attempt ${j.ingest.leaseEpoch})${j.ingest.error ? `: ${j.ingest.error}` : ''}; files ${filesText(j.ingest.files)}`);
  } else {
    console.log('Not analysed yet: no bundle has been ingested for this job');
  }
  if (j.corrected) console.log('Outcome corrected from finish-audit');
  if (j.liveCostUsd && j.ledgerCostUsd && j.liveCostUsd !== j.ledgerCostUsd) console.log(`Live ${j.liveCostUsd} USD / ledger ${j.ledgerCostUsd} USD`);
  printSlices('Stage', j.byStage);
  printSlices('Role', j.byRole);
  printSlices('Model', j.byModel);
  if (j.stories.length > 0) {
    table(['Attempt', 'Story', 'Attempts', 'First pass', 'Success', 'Cost (USD)'], j.stories.map((s) => [
      String(s.leaseEpoch), s.storyId, String(s.attempts), yesNo(s.firstPassSuccess), yesNo(s.success), s.costUsd,
    ]));
  }
  if (j.reviews.length > 0) {
    table(['Attempt', 'Story', 'Reviewer', 'Passed', 'Findings'], j.reviews.map((r) => [
      String(r.leaseEpoch), r.storyId ?? '-', r.reviewer, yesNo(r.passed), countsText(r.findingsBySeverity),
    ]));
  }
}

/** `koda fleet job analytics <jobId>` (spec §4.4). */
export function registerJobAnalytics(job: Command): void {
  job
    .command('analytics <jobId>')
    .description("A job's cost by stage, role and model, its stories and reviews (from its ingested bundle)")
    .option('--project <slug>', 'Project slug (uses config if not provided)')
    .option('--json', 'Output as JSON')
    .action(async (jobId: string, o: { project?: string; json?: boolean }) => {
      try {
        const { projectSlug: slug } = await withContext({ projectSlug: o.project });
        const j = unwrap<JobAnalyticsDto>(await projectFleetAnalyticsControllerJob({ path: { slug, id: jobId } }));
        if (o.json) printJson(j);
        else printJobAnalytics(j);
        process.exit(0);
      } catch (err: unknown) {
        handleApiError(err, { notFoundMessage: `Job not found: ${jobId}` });
      }
    });
}
