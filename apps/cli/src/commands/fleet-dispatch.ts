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
import { handleApiError } from '../utils/error';
import { parsePositiveInt } from '../utils/parse-positive-int';
import { parseUsd } from '../utils/parse-usd';
import { type BashMode, type FleetPage, bashFlagProblem, handleFleetConflict, handleFleetValidation, parseApprovalTimeout, parseBashMode, printPlacement, resolveRepo, resolveRunner, runnerNamesOrEmpty } from './fleet-shared';

const ACTIVE = new Set(['QUEUED', 'ASSIGNED', 'RUNNING', 'UPLOADING']);
const collect = (value: string, previous: string[]): string[] => [...previous, value];

interface DispatchOptions {
  repo: string; feature?: string; review?: number; fix?: number; maxCost: number; plan?: string; ref?: string;
  profile: string[]; label: string[]; pin?: string; ticket: string[];
  bashMode?: BashMode; approvalTimeout?: number;
  project?: string; json?: boolean;
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
  return handleFleetValidation(message);
}

async function buildBody(slug: string, o: DispatchOptions): Promise<DispatchFleetJobDto | null> {
  const hasPrCommand = o.review !== undefined || o.fix !== undefined;
  if (o.review !== undefined && o.fix !== undefined) return invalid('Use --review or --fix, not both');
  if (hasPrCommand && (
    o.feature !== undefined || o.plan !== undefined || o.ref !== undefined || o.ticket.length > 0 ||
    o.bashMode !== undefined || o.approvalTimeout !== undefined
  )) {
    return invalid('--feature, --plan, --ref, --ticket, --bash-mode and --approval-timeout are not for --review or --fix');
  }
  if (!hasPrCommand && o.feature === undefined) {
    return invalid('--feature is required unless --review or --fix is given');
  }
  const bashProblem = bashFlagProblem(o);
  if (bashProblem) return invalid(bashProblem);
  if (o.pin && o.label.length > 0) return invalid('Use --label or --pin, not both: a pinned job ignores labels');
  const repo = await resolveRepo(slug, o.repo);
  if (!repo) return invalid(`Unknown repo "${o.repo}" in project ${slug}: koda fleet repo list`);
  const pinned = o.pin ? await resolveRunner(slug, o.pin) : null;
  if (o.pin && !pinned) return invalid(`Unknown runner "${o.pin}"`);
  const prNumber = o.review ?? o.fix;
  if (prNumber !== undefined) {
    return {
      repoId: repo.id, command: o.review !== undefined ? 'REVIEW' : 'FIX', prNumber, maxCostUsd: o.maxCost,
      ...(o.profile.length > 0 ? { profiles: o.profile } : {}),
      ...(o.label.length > 0 ? { selectorLabels: o.label } : {}),
      ...(pinned ? { pinnedRunnerId: pinned.id } : {}),
    };
  }
  return {
    repoId: repo.id, command: o.plan ? 'PLAN' : 'RUN', feature: o.feature, maxCostUsd: o.maxCost,
    ...(o.plan ? { planFrom: o.plan } : {}),
    ...(o.profile.length > 0 ? { profiles: o.profile } : {}),
    ...(o.label.length > 0 ? { selectorLabels: o.label } : {}),
    ...(pinned ? { pinnedRunnerId: pinned.id } : {}),
    ...(o.ticket.length > 0 ? { ticketRefs: o.ticket } : {}),
    ...(o.ref ? { ref: o.ref } : {}),
    ...(o.bashMode ? { bashMode: o.bashMode } : {}),
    ...(o.approvalTimeout !== undefined ? { approvalTimeoutSec: o.approvalTimeout } : {}),
  };
}

/** A 409 on dispatch names the active job (D133, overview D121); any other error, or a failed lookup, reports as-is. */
async function explainConflict(err: unknown, slug: string, body: DispatchFleetJobDto, feature: string): Promise<void> {
  if (apiErrorCode(err) !== 409) return handleApiError(err);
  let active: FleetJobDto | null = null;
  try {
    active = await findActiveJob(slug, body.repoId, feature);
  } catch {
    // The lookup is a courtesy; the original 409 is the answer.
  }
  if (!active) return handleApiError(err);
  handleFleetConflict(`An active job already runs ${feature} on this repo: ${active.id} (${active.state}). koda fleet job show ${active.id}`);
}

export function registerFleetDispatch(fleet: Command): void {
  fleet
    .command('dispatch')
    .description('Dispatch a nax run (or, with --plan, a nax plan) for a project repo to a fleet runner')
    .requiredOption('--repo <repo>', 'Repo id or owner/name (koda fleet repo list)')
    .option('--feature <name>', 'nax feature name')
    .option('--review <pr>', 'Review a pull request', parsePositiveInt)
    .option('--fix <pr>', 'Fix a pull request', parsePositiveInt)
    .requiredOption('--max-cost <usd>', 'Budget in USD, at most 4 decimals', parseUsd)
    .option('--plan <specPath>', 'Run nax plan from this repo-relative spec instead of nax run')
    .option('--ref <ref>', 'Git ref to check out (default: the repo default branch)')
    .option('--profile <name>', 'nax profile, repeatable; later wins', collect, [] as string[])
    .option('--label <label>', 'Only runners with this label, repeatable', collect, [] as string[])
    .option('--pin <runner>', 'Run on this runner (id or name); excludes --label')
    .option('--ticket <ref>', 'Ticket this job works on (KEY-N), repeatable; a RUN moves CREATED/VERIFIED tickets to IN_PROGRESS', collect, [] as string[])
    .option('--bash-mode <mode>', 'Shell command approvals: raw (default), gated or escalate; gated/escalate send asks to the approvals inbox (RUN only)', parseBashMode)
    .option('--approval-timeout <seconds>', 'Seconds an ask waits for a decision before nax denies it (30-3600, default 600); gated/escalate only', parseApprovalTimeout)
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
        else printPlacement(result, result.placement.assigned ? await runnerNamesOrEmpty(slug) : new Map());
        process.exit(0);
      } catch (err: unknown) {
        if (body) {
          const feature = body.prNumber !== undefined ? `review-pr-${body.prNumber}` : body.feature;
          if (feature) await explainConflict(err, slug, body, feature);
          else handleApiError(err);
        } else handleApiError(err);
      }
    });
}
