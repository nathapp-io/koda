import { Command, InvalidArgumentError } from 'commander';
import {
  fleetJobsControllerList,
  projectFleetSchedulesControllerCreate,
  projectFleetSchedulesControllerDisable,
  projectFleetSchedulesControllerEnable,
  projectFleetSchedulesControllerGet,
  projectFleetSchedulesControllerList,
  projectFleetSchedulesControllerRemove,
  projectFleetSchedulesControllerUpdate,
  type CreateScheduleDto,
  type FleetJobDto,
  type ScheduleDto,
  type UpdateScheduleDto,
} from '../generated';
import { unwrap } from '../utils/api';
import { apiErrorCode } from '../utils/api-error-code';
import { withContext } from '../utils/context';
import { handleApiError } from '../utils/error';
import { requireForce } from '../utils/force';
import { table } from '../utils/output';
import { parseUsd } from '../utils/parse-usd';
import { type FleetPage, handleFleetConflict, handleFleetValidation, repoNamesOrEmpty, resolveRepo, resolveRunner } from './fleet-shared';

const collect = (value: string, previous: string[]): string[] => [...previous, value];

/** 1-20: the stall limit (commander reads `--no-progress-limit` as a negation, so the option is `--stall-after`; plan D209). */
export function parseStallAfter(value: string): number {
  if (!/^\d{1,2}$/.test(value) || Number(value) < 1 || Number(value) > 20) throw new InvalidArgumentError('expected a whole number from 1 to 20');
  return Number(value);
}

export function scheduleState(s: ScheduleDto): string {
  return s.enabled ? 'enabled' : `disabled (${s.disabledReason ?? 'unknown'})`;
}

/** `passed/total` of a job's nax progress, or `-`. */
export function passedOf(job: FleetJobDto): string {
  const p = job.progress as unknown as Record<string, unknown> | null;
  if (!p || typeof p['passed'] !== 'number') return '-';
  return `${p['passed']}/${typeof p['total'] === 'number' ? p['total'] : '?'}`;
}

function printSchedule(verb: string, s: ScheduleDto): void {
  console.log(`${verb} schedule ${s.id}: ${s.name}, ${s.feature} on ${s.cron} (${s.timezone}), ${scheduleState(s)}`);
  if (s.enabled && s.nextFireAt) console.log(`Next fire ${s.nextFireAt}`);
}

function registerList(schedule: Command): void {
  schedule
    .command('list')
    .description("List the project's schedules")
    .option('--project <slug>', 'Project slug (uses config if not provided)')
    .option('--json', 'Output as JSON')
    .action(async (options: { project?: string; json?: boolean }) => {
      try {
        const ctx = await withContext({ projectSlug: options.project });
        const rows = unwrap<ScheduleDto[]>(await projectFleetSchedulesControllerList({ path: { slug: ctx.projectSlug } }));
        if (options.json) {
          console.log(JSON.stringify(rows, null, 2));
        } else {
          const repos = await repoNamesOrEmpty(ctx.projectSlug);
          table(['ID', 'Name', 'Repo', 'Feature', 'Cron', 'Next fire / state', 'Last job'], rows.map((s) => [
            s.id, s.name, repos.get(s.repoId) ?? s.repoId, s.feature, `${s.cron} (${s.timezone})`,
            s.enabled ? (s.nextFireAt ?? '-') : scheduleState(s), s.lastJobId ?? '-',
          ]));
        }
        process.exit(0);
      } catch (err: unknown) {
        handleApiError(err);
      }
    });
}

function registerShow(schedule: Command): void {
  schedule
    .command('show <scheduleId>')
    .description("Show a schedule and the last 10 jobs it dispatched (passed stories, cost, coalesced ticks, WIP push, reason)")
    .option('--project <slug>', 'Project slug (uses config if not provided)')
    .option('--json', 'Output as JSON')
    .action(async (scheduleId: string, options: { project?: string; json?: boolean }) => {
      try {
        const ctx = await withContext({ projectSlug: options.project });
        const slug = ctx.projectSlug;
        const found = unwrap<ScheduleDto>(await projectFleetSchedulesControllerGet({ path: { slug, id: scheduleId } }));
        const page = unwrap<FleetPage<FleetJobDto>>(await fleetJobsControllerList({ path: { slug }, query: { scheduleId, size: 10 } }));
        if (options.json) {
          console.log(JSON.stringify({ schedule: found, jobs: page.records }, null, 2));
        } else {
          printSchedule('Schedule', found);
          console.log(`Template: ${found.maxCostUsd} USD per run, ref ${found.ref}, stalls after ${found.noProgressLimit} runs without progress (${found.noProgressTicks} so far)`);
          console.log(`Stories passed so far: ${found.lastPassedCount}; total cost $${found.totalCostUsd}`);
          table(['Job', 'State', 'Passed', 'Cost', 'Coalesced', 'WIP push', 'Reason'], page.records.map((j) => [
            j.id, j.state, passedOf(j), `$${j.costSpentUsd}`, String(j.coalescedCount), j.wipPush ?? '-', j.stateReason ?? '-',
          ]));
        }
        process.exit(0);
      } catch (err: unknown) {
        handleApiError(err, { notFoundMessage: `Schedule not found: ${scheduleId}` });
      }
    });
}

interface AddOptions {
  repo: string; feature: string; cron: string; timezone: string; maxCost: number; name?: string; ref?: string;
  profile: string[]; label: string[]; pin?: string; stallAfter?: number; project?: string; json?: boolean;
}

function registerAdd(schedule: Command): void {
  schedule
    .command('add')
    .description('Create a schedule that runs one feature on a cron until it is done (project DEVELOPER+)')
    .requiredOption('--repo <repo>', 'Repo id or owner/name (koda fleet repo list)')
    .requiredOption('--feature <name>', 'nax feature name')
    .requiredOption('--cron <expr>', 'Five-field cron, quoted: "0 9 * * 1-5" (fires at least 15 minutes apart)')
    .requiredOption('--timezone <iana>', 'IANA timezone the cron is read in, for example Asia/Singapore (required)')
    .requiredOption('--max-cost <usd>', 'Budget of each run in USD, at most 4 decimals', parseUsd)
    .option('--name <name>', 'Display name (default: the feature)')
    .option('--ref <ref>', 'Git ref to check out (default: the repo default branch)')
    .option('--profile <name>', 'nax profile, repeatable; later wins', collect, [] as string[])
    .option('--label <label>', 'Only runners with this label, repeatable', collect, [] as string[])
    .option('--pin <runner>', 'Run on this runner (id or name); excludes --label')
    .option('--stall-after <ticks>', 'Disable after this many runs in a row without a newly passed story (1-20, default 3)', parseStallAfter)
    .option('--project <slug>', 'Project slug (uses config if not provided)')
    .option('--json', 'Output as JSON')
    .action(async (o: AddOptions) => {
      try {
        const ctx = await withContext({ projectSlug: o.project });
        const slug = ctx.projectSlug;
        if (o.pin && o.label.length > 0) return handleFleetValidation('Use --label or --pin, not both: a pinned job ignores labels');
        const repo = await resolveRepo(slug, o.repo);
        if (!repo) return handleFleetValidation(`Unknown repo "${o.repo}" in project ${slug}: koda fleet repo list`);
        const pinned = o.pin ? await resolveRunner(slug, o.pin) : null;
        if (o.pin && !pinned) return handleFleetValidation(`Unknown runner "${o.pin}"`);
        const body: CreateScheduleDto = {
          name: o.name ?? o.feature, repoId: repo.id, feature: o.feature, cron: o.cron, timezone: o.timezone, maxCostUsd: o.maxCost,
          ...(o.ref ? { ref: o.ref } : {}),
          ...(o.profile.length > 0 ? { profiles: o.profile } : {}),
          ...(o.label.length > 0 ? { selectorLabels: o.label } : {}),
          ...(pinned ? { pinnedRunnerId: pinned.id } : {}),
          ...(o.stallAfter !== undefined ? { noProgressLimit: o.stallAfter } : {}),
        };
        const created = unwrap<ScheduleDto>(await projectFleetSchedulesControllerCreate({ path: { slug }, body }));
        if (o.json) console.log(JSON.stringify(created, null, 2));
        else printSchedule('Created', created);
        process.exit(0);
      } catch (err: unknown) {
        handleApiError(err);
      }
    });
}

interface EditOptions {
  name?: string; cron?: string; timezone?: string; maxCost?: number; ref?: string; profile: string[]; label: string[]; pin?: string;
  unpin?: boolean; clearProfiles?: boolean; clearLabels?: boolean; stallAfter?: number; project?: string; json?: boolean;
}

/** Only the fields the user gave; `pinned` is the resolved runner id, null to unpin, undefined to leave alone. */
function editBody(o: EditOptions, pinned: string | null | undefined): UpdateScheduleDto {
  return {
    ...(o.name !== undefined ? { name: o.name } : {}),
    ...(o.cron !== undefined ? { cron: o.cron } : {}),
    ...(o.timezone !== undefined ? { timezone: o.timezone } : {}),
    ...(o.maxCost !== undefined ? { maxCostUsd: o.maxCost } : {}),
    ...(o.ref !== undefined ? { ref: o.ref } : {}),
    ...(o.clearProfiles ? { profiles: [] } : o.profile.length > 0 ? { profiles: o.profile } : {}),
    ...(o.clearLabels ? { selectorLabels: [] } : o.label.length > 0 ? { selectorLabels: o.label } : {}),
    ...(pinned !== undefined ? { pinnedRunnerId: pinned } : {}),
    ...(o.stallAfter !== undefined ? { noProgressLimit: o.stallAfter } : {}),
  };
}

function registerEdit(schedule: Command): void {
  schedule
    .command('edit <scheduleId>')
    .description('Change a schedule (the owner or a project ADMIN); the repo and the feature are fixed')
    .option('--name <name>', 'Display name')
    .option('--cron <expr>', 'Five-field cron, quoted')
    .option('--timezone <iana>', 'Timezone the cron is read in')
    .option('--max-cost <usd>', 'Budget of each run in USD', parseUsd)
    .option('--ref <ref>', 'Git ref to check out')
    .option('--profile <name>', 'Replace the profile chain; repeatable', collect, [] as string[])
    .option('--clear-profiles', 'Remove every profile')
    .option('--label <label>', 'Replace the selector labels; repeatable', collect, [] as string[])
    .option('--clear-labels', 'Remove every selector label')
    .option('--pin <runner>', 'Run on this runner (id or name)')
    .option('--unpin', 'Stop pinning to a runner')
    .option('--stall-after <ticks>', 'Disable after this many runs without a newly passed story (1-20)', parseStallAfter)
    .option('--project <slug>', 'Project slug (uses config if not provided)')
    .option('--json', 'Output as JSON')
    .action(async (scheduleId: string, o: EditOptions) => {
      try {
        const ctx = await withContext({ projectSlug: o.project });
        const slug = ctx.projectSlug;
        if (o.pin && o.unpin) return handleFleetValidation('Use --pin or --unpin, not both');
        let pinned: string | null | undefined = o.unpin ? null : undefined;
        if (o.pin) {
          const runner = await resolveRunner(slug, o.pin);
          if (!runner) return handleFleetValidation(`Unknown runner "${o.pin}"`);
          pinned = runner.id;
        }
        const body = editBody(o, pinned);
        if (Object.keys(body).length === 0) return handleFleetValidation('Nothing to change: give at least one option');
        const updated = unwrap<ScheduleDto>(await projectFleetSchedulesControllerUpdate({ path: { slug, id: scheduleId }, body }));
        if (o.json) console.log(JSON.stringify(updated, null, 2));
        else printSchedule('Updated', updated);
        process.exit(0);
      } catch (err: unknown) {
        handleApiError(err, { notFoundMessage: `Schedule not found: ${scheduleId}` });
      }
    });
}

function registerToggle(schedule: Command, verb: 'enable' | 'disable'): void {
  schedule
    .command(`${verb} <scheduleId>`)
    .description(verb === 'enable'
      ? 'Enable a schedule: resets the stall counter and computes the next fire from now (the owner or a project ADMIN)'
      : 'Disable a schedule (the owner or a project ADMIN)')
    .option('--project <slug>', 'Project slug (uses config if not provided)')
    .option('--json', 'Output as JSON')
    .action(async (scheduleId: string, options: { project?: string; json?: boolean }) => {
      try {
        const ctx = await withContext({ projectSlug: options.project });
        const path = { slug: ctx.projectSlug, id: scheduleId };
        const result = unwrap<ScheduleDto>(verb === 'enable'
          ? await projectFleetSchedulesControllerEnable({ path })
          : await projectFleetSchedulesControllerDisable({ path }));
        if (options.json) console.log(JSON.stringify(result, null, 2));
        else printSchedule(verb === 'enable' ? 'Enabled' : 'Disabled', result);
        process.exit(0);
      } catch (err: unknown) {
        // Enable answers 409 when the owner can no longer dispatch (plan D211): exit 1 with the API's message.
        if (verb === 'enable' && apiErrorCode(err) === 409) return handleFleetConflict(`${(err as { message?: string }).message ?? 'Conflict'}`);
        handleApiError(err, { notFoundMessage: `Schedule not found: ${scheduleId}` });
      }
    });
}

function registerRemove(schedule: Command): void {
  schedule
    .command('rm <scheduleId>')
    .description("Delete a schedule; the jobs it dispatched are kept (the owner or a project ADMIN)")
    .option('--project <slug>', 'Project slug (uses config if not provided)')
    .option('--force', 'Confirm the deletion')
    .action(async (scheduleId: string, options: { project?: string; force?: boolean }) => {
      if (!requireForce(options.force)) return;
      try {
        const ctx = await withContext({ projectSlug: options.project });
        await projectFleetSchedulesControllerRemove({ path: { slug: ctx.projectSlug, id: scheduleId } });
        console.log(`Removed schedule ${scheduleId}`);
        process.exit(0);
      } catch (err: unknown) {
        handleApiError(err, { notFoundMessage: `Schedule not found: ${scheduleId}` });
      }
    });
}

/** commander keeps an option's value between parses of one Command (tests and embedders reuse a program): clear the previous invocation before each schedule subcommand. */
function resetSubcommandOptions(subcommand: Command): void {
  for (const option of subcommand.options) subcommand.setOptionValue(option.attributeName(), option.defaultValue);
}

/** `koda fleet schedule …`: C4 cron schedules that drive one feature to done (S1b §3.4, plan D209). */
export function registerFleetSchedule(fleet: Command): void {
  const schedule = fleet.command('schedule');
  schedule.description('Fleet schedules: run one feature on a cron until it is done');
  schedule.hook('preSubcommand', (_schedule, subcommand) => resetSubcommandOptions(subcommand));
  registerList(schedule);
  registerShow(schedule);
  registerAdd(schedule);
  registerEdit(schedule);
  registerToggle(schedule, 'enable');
  registerToggle(schedule, 'disable');
  registerRemove(schedule);
}
