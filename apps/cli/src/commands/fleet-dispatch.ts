import { Command } from 'commander';
import {
  fleetJobsControllerDispatch,
  fleetJobsControllerList,
  type DispatchFleetJobDto,
  type DispatchResultDto,
  type FleetJobDto,
} from '../generated';
import { unwrap } from '../utils/api';
import { apiErrorCode } from '../utils/api-error-code';
import { withContext } from '../utils/context';
import { error } from '../utils/output';
import { parseUsd } from '../utils/parse-usd';
import { type FleetPage, handleFleetError, printPlacement, resolveRepo, resolveRunner, runnerNames } from './fleet-shared';

const ACTIVE = new Set(['QUEUED', 'ASSIGNED', 'RUNNING', 'UPLOADING']);
const collect = (value: string, previous: string[]): string[] => [...previous, value];

interface DispatchOptions {
  repo: string; feature: string; maxCost: number; plan?: string; ref?: string;
  profile: string[]; label: string[]; pin?: string; project?: string; json?: boolean;
}

/**
 * The active job behind a dispatch 409 (overview D121): the partial unique index allows at most one active
 * job per (repo, feature), and the list is newest first.
 */
export async function findActiveJob(slug: string, repoId: string, feature: string): Promise<FleetJobDto | null> {
  const page = unwrap<FleetPage<FleetJobDto>>(await fleetJobsControllerList({ path: { slug }, query: { repoId, feature, size: 20 } }));
  return page.records.find((j) => ACTIVE.has(j.state)) ?? null;
}

/** Validation failure: message to stderr, exit 3 (`.nax/rules/cli.md`). Returns null so callers can `return invalid(...)`. */
function invalid(message: string): null {
  error(message);
  process.exit(3);
  return null;
}

async function buildBody(slug: string, o: DispatchOptions): Promise<DispatchFleetJobDto | null> {
  if (o.pin && o.label.length > 0) return invalid('Use --label or --pin, not both: a pinned job ignores labels');
  const repo = await resolveRepo(slug, o.repo);
  if (!repo) return invalid(`Unknown repo "${o.repo}" in project ${slug}: koda fleet repo list`);
  const pinned = o.pin ? await resolveRunner(slug, o.pin) : null;
  if (o.pin && !pinned) return invalid(`Unknown runner "${o.pin}"`);
  return {
    repoId: repo.id, command: o.plan ? 'PLAN' : 'RUN', feature: o.feature, maxCostUsd: o.maxCost,
    ...(o.plan ? { planFrom: o.plan } : {}),
    ...(o.profile.length > 0 ? { profiles: o.profile } : {}),
    ...(o.label.length > 0 ? { selectorLabels: o.label } : {}),
    ...(pinned ? { pinnedRunnerId: pinned.id } : {}),
    ...(o.ref ? { ref: o.ref } : {}),
  };
}

/** A 409 on dispatch names the active job (D133, overview D121); any other error, or a failed lookup, reports as-is. */
async function explainConflict(err: unknown, slug: string, body: DispatchFleetJobDto): Promise<void> {
  if (apiErrorCode(err) !== 409) return handleFleetError(err);
  let active: FleetJobDto | null = null;
  try {
    active = await findActiveJob(slug, body.repoId, body.feature);
  } catch {
    // The lookup is a courtesy; the original 409 is the answer.
  }
  if (!active) return handleFleetError(err);
  error(`An active job already runs ${body.feature} on this repo: ${active.id} (${active.state}). koda fleet job show ${active.id}`);
  process.exit(1);
}

export function registerFleetDispatch(fleet: Command): void {
  fleet
    .command('dispatch')
    .description('Dispatch a nax run (or, with --plan, a nax plan) for a project repo to a fleet runner')
    .requiredOption('--repo <repo>', 'Repo id or owner/name (koda fleet repo list)')
    .requiredOption('--feature <name>', 'nax feature name')
    .requiredOption('--max-cost <usd>', 'Budget in USD, at most 4 decimals', parseUsd)
    .option('--plan <specPath>', 'Run nax plan from this repo-relative spec instead of nax run')
    .option('--ref <ref>', 'Git ref to check out (default: the repo default branch)')
    .option('--profile <name>', 'nax profile, repeatable; later wins', collect, [] as string[])
    .option('--label <label>', 'Only runners with this label, repeatable', collect, [] as string[])
    .option('--pin <runner>', 'Run on this runner (id or name); excludes --label')
    .option('--project <slug>', 'Project slug (uses config if not provided)')
    .option('--json', 'Output as JSON')
    .action(async (options: DispatchOptions) => {
      let body: DispatchFleetJobDto | null = null;
      let slug = '';
      try {
        const ctx = await withContext({ projectSlug: options.project });
        slug = ctx.projectSlug;
        body = await buildBody(slug, options);
        if (!body) return;
        const result = unwrap<DispatchResultDto>(await fleetJobsControllerDispatch({ path: { slug }, body }));
        if (options.json) console.log(JSON.stringify(result, null, 2));
        else printPlacement(result, result.placement.assigned ? await runnerNames(slug) : new Map());
        process.exit(0);
      } catch (err: unknown) {
        if (body) await explainConflict(err, slug, body);
        else handleFleetError(err);
      }
    });
}
