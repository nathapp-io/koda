import { Command } from 'commander';
import { writeFile } from 'fs/promises';
import {
  fleetJobsControllerCancel,
  fleetJobsControllerGet,
  fleetJobsControllerList,
  fleetJobsControllerRequeue,
  jobBundleControllerDownload,
  type DispatchResultDto,
  type FleetJobDto,
} from '../generated';
import { unwrap } from '../utils/api';
import { withContext } from '../utils/context';
import { handleApiError } from '../utils/error';
import { error, table } from '../utils/output';
import { parsePositiveInt } from '../utils/parse-positive-int';
import { registerLogs } from './fleet-job-logs';
import { registerJobAnalytics } from './fleet-analytics';
import { ago, bashModeText, type FleetPage, handleFleetValidation, pageHint, printPlacement, resolveRepo, resolveRunner, runnerNames, runnerNamesOrEmpty } from './fleet-shared';

const STATES = ['QUEUED', 'ASSIGNED', 'RUNNING', 'UPLOADING', 'COMPLETED', 'FAILED', 'ESCALATED', 'CRASHED', 'CANCELLED'] as const;
type JobState = (typeof STATES)[number];

function invalid(message: string): null {
  return handleFleetValidation(message);
}

interface ListOptions { state?: string; repo?: string; runner?: string; requestedBy?: string; feature?: string; page: number; size: number; project?: string; json?: boolean }

async function listQuery(slug: string, o: ListOptions): Promise<Record<string, unknown> | null> {
  if (o.state && !(STATES as readonly string[]).includes(o.state)) return invalid(`Unknown state "${o.state}": ${STATES.join(', ')}`);
  const repo = o.repo ? await resolveRepo(slug, o.repo) : null;
  if (o.repo && !repo) return invalid(`Unknown repo "${o.repo}"`);
  const runner = o.runner ? await resolveRunner(slug, o.runner) : null;
  if (o.runner && !runner) return invalid(`Unknown runner "${o.runner}"`);
  return {
    current: o.page, size: o.size,
    ...(o.state ? { state: o.state as JobState } : {}),
    ...(repo ? { repoId: repo.id } : {}),
    ...(runner ? { runnerId: runner.id } : {}),
    ...(o.requestedBy ? { requestedById: o.requestedBy } : {}),
    ...(o.feature ? { feature: o.feature } : {}),
  };
}

function registerList(job: Command): void {
  job
    .command('list')
    .description('List fleet jobs, newest first')
    .option('--state <state>', `One of ${STATES.join(', ')}`)
    .option('--repo <repo>', 'Repo id or owner/name')
    .option('--runner <runner>', 'Runner id or name')
    .option('--requested-by <userId>', 'Requester user id')
    .option('--feature <name>', 'nax feature name')
    .option('--page <n>', 'Page number', parsePositiveInt, 1)
    .option('--size <n>', 'Page size (1-100)', parsePositiveInt, 20)
    .option('--project <slug>', 'Project slug (uses config if not provided)')
    .option('--json', 'Output as JSON')
    .action(async (options: ListOptions) => {
      try {
        const { projectSlug: slug } = await withContext({ projectSlug: options.project });
        const query = await listQuery(slug, options);
        if (!query) return;
        const page = unwrap<FleetPage<FleetJobDto>>(await fleetJobsControllerList({ path: { slug }, query }));
        if (options.json) {
          console.log(JSON.stringify(page, null, 2));
        } else {
          const names = await runnerNames(slug);
          table(['ID', 'State', 'Cmd', 'Feature', 'Runner', 'Cost', 'Queued'], page.records.map((j) => [
            j.id, j.state, j.command, j.feature, j.runnerId ? names.get(j.runnerId) ?? j.runnerId : '-',
            `${j.costSpentUsd}/${j.maxCostUsd}`, ago(j.queuedAt),
          ]));
          const hint = pageHint(page);
          if (hint) console.log(hint);
        }
        process.exit(0);
      } catch (err: unknown) {
        handleApiError(err);
      }
    });
}

function showRows(j: FleetJobDto, runner: string): string[][] {
  const opt = (v: string | null | undefined) => v ?? '-';
  return [
    ['ID', j.id], ['State', j.state], ['Reason', opt(j.stateReason)], ['Command', j.command], ['Feature', j.feature],
    ['Plan from', opt(j.planFrom)], ['Ref', j.ref], ['Profiles', j.profiles.join(',') || '-'],
    ['Bash mode', bashModeText(j.bashMode, j.approvalTimeoutSec)], ['Pending approvals', String(j.pendingApprovals)],
    ['Runner', runner],
    ['Story', opt(j.currentStoryId)], ['Phase', opt(j.currentPhase)], ['Cost (USD)', `${j.costSpentUsd} of ${j.maxCostUsd}`],
    ['Finish', opt(j.finishResult)], ['Escalation', opt(j.escalationReason)], ['Branch', opt(j.resultBranch)],
    ['PR', opt(j.resultPrUrl)], ['Queued', j.queuedAt], ['Finished', opt(j.finishedAt)],
  ];
}

function registerShow(job: Command): void {
  job
    .command('show <jobId>')
    .description('Show one job: state, progress, cost and result')
    .option('--project <slug>', 'Project slug (uses config if not provided)')
    .option('--json', 'Output as JSON')
    .action(async (jobId: string, options: { project?: string; json?: boolean }) => {
      try {
        const { projectSlug: slug } = await withContext({ projectSlug: options.project });
        const j = unwrap<FleetJobDto>(await fleetJobsControllerGet({ path: { slug, id: jobId } }));
        if (options.json) {
          console.log(JSON.stringify(j, null, 2));
        } else {
          const runner = j.runnerId ? (await runnerNames(slug)).get(j.runnerId) ?? j.runnerId : '-';
          table(['Field', 'Value'], showRows(j, runner));
        }
        process.exit(0);
      } catch (err: unknown) {
        handleApiError(err, { notFoundMessage: `Job not found: ${jobId}` });
      }
    });
}

function registerCancel(job: Command): void {
  job
    .command('cancel <jobId>')
    .description('Cancel a job: the runner stops nax and the job ends CANCELLED')
    .option('--project <slug>', 'Project slug (uses config if not provided)')
    .option('--json', 'Output as JSON')
    .action(async (jobId: string, options: { project?: string; json?: boolean }) => {
      try {
        const { projectSlug: slug } = await withContext({ projectSlug: options.project });
        const j = unwrap<FleetJobDto>(await fleetJobsControllerCancel({ path: { slug, id: jobId } }));
        if (options.json) console.log(JSON.stringify(j, null, 2));
        else console.log(`Cancel requested: job ${j.id} is ${j.state}`);
        process.exit(0);
      } catch (err: unknown) {
        handleApiError(err, { notFoundMessage: `Job not found: ${jobId}` });
      }
    });
}

function registerRequeue(job: Command): void {
  job
    .command('requeue <jobId>')
    .description('Queue a CRASHED, FAILED or CANCELLED job again')
    .option('--project <slug>', 'Project slug (uses config if not provided)')
    .option('--json', 'Output as JSON')
    .action(async (jobId: string, options: { project?: string; json?: boolean }) => {
      try {
        const { projectSlug: slug } = await withContext({ projectSlug: options.project });
        const result = unwrap<DispatchResultDto>(await fleetJobsControllerRequeue({ path: { slug, id: jobId } }));
        if (options.json) console.log(JSON.stringify(result, null, 2));
        else printPlacement(result, result.placement.assigned ? await runnerNamesOrEmpty(slug) : new Map());
        process.exit(0);
      } catch (err: unknown) {
        handleApiError(err, { notFoundMessage: `Job not found: ${jobId}` });
      }
    });
}

function registerBundle(job: Command): void {
  job
    .command('bundle <jobId>')
    .description("Download the job's artifact bundle (tar.gz)")
    .option('--out <path>', 'Output file (default: koda-job-<id>.tar.gz)')
    .option('--force', 'Overwrite the output file if it exists')
    .option('--project <slug>', 'Project slug (uses config if not provided)')
    .action(async (jobId: string, options: { out?: string; force?: boolean; project?: string }) => {
      const out = options.out ?? `koda-job-${jobId}.tar.gz`;
      try {
        const { projectSlug: slug } = await withContext({ projectSlug: options.project });
        // Fully downloaded before the file is opened (D134): a failed download leaves no file behind.
        const bytes = await jobBundleControllerDownload({ path: { slug, id: jobId }, parseAs: 'arrayBuffer' });
        if (!(bytes instanceof ArrayBuffer)) throw new Error('unexpected bundle response');
        const data = new Uint8Array(bytes);
        await writeFile(out, data, { flag: options.force ? 'w' : 'wx' });
        console.log(`Wrote ${out} (${data.byteLength} bytes)`);
        process.exit(0);
      } catch (err: unknown) {
        if ((err as { code?: unknown } | null)?.code === 'EEXIST') {
          error(`${out} exists; pass --force to overwrite or --out <path>`);
          process.exit(1);
          return;
        }
        handleApiError(err, { notFoundMessage: `No bundle for job ${jobId}` });
      }
    });
}

export function registerFleetJob(fleet: Command): void {
  const job = fleet.command('job');
  job.description('Fleet jobs: list, show, cancel, requeue, bundle, logs, analytics');
  registerList(job);
  registerShow(job);
  registerCancel(job);
  registerRequeue(job);
  registerBundle(job);
  registerLogs(job);
  registerJobAnalytics(job);
}
