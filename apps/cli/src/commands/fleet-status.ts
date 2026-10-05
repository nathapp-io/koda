import { Command } from 'commander';
import {
  fleetDashboardControllerGet,
  projectFleetDashboardControllerGet,
  type AttentionItemDto,
  type FleetDashboardDto,
  type RunnerConditionDto,
} from '../generated';
import { unwrap } from '../utils/api';
import { withContext } from '../utils/context';
import { handleApiError } from '../utils/error';
import { table } from '../utils/output';
import { escapeControls } from './fleet-job-logs';
import { ADMIN_TOKEN_HINT, ago, handleFleetValidation } from './fleet-shared';

interface StatusOptions { project?: string; allProjects?: boolean; json?: boolean }

/** 42s, 3m 10s, 2h 1m. */
export function secText(sec = 0): string {
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ${sec % 60}s`;
  return `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m`;
}

function unplaceableText(a: AttentionItemDto): string {
  const shown = a.reasons ?? [];
  const reasons = shown.map((r) => `${r.runnerName} ${r.reason}`).join(', ');
  const more = (a.reasonsTotal ?? 0) > shown.length ? ` (+${(a.reasonsTotal ?? 0) - shown.length} more)` : '';
  switch (a.verdict) {
    case 'never': return `No runner can ever run this: ${reasons}${more}`;
    case 'budget_paused': return 'Budget paused; this job will be cancelled';
    case 'runners_paused': return 'Every runner is budget-paused';
    case 'waiting_capacity': return 'Waiting for a free runner';
    case 'no_runners': return 'No runner can take this job';
    case 'fits_not_placed': return 'A runner fits but the job has not been placed';
    default: return `No runner fits: ${reasons}${more}`;
  }
}

function conditionText(c: RunnerConditionDto): string {
  switch (c.type) {
    case 'offline': return c.jobsHeld ? `offline, holding ${c.jobsHeld} job(s)` : 'offline';
    case 'credential': return `credential ${c.providerId ?? '?'} ${c.why ?? ''}`.trim();
    case 'stale_nax': return `nax ${c.version ?? '?'} behind ${c.latest ?? '?'}`;
    default: return 'configuration problem';
  }
}

/** English wording of an attention item, built from its structured fields (the API sends no prose, spec §2). */
export function describeAttention(a: AttentionItemDto): string {
  switch (a.kind) {
    case 'job_silent':
      return a.stage === 'starting'
        ? `Assigned to ${a.runnerName ?? '?'} ${secText(a.silentSec)} ago, not started`
        : `No heartbeat for ${secText(a.silentSec)} on ${a.runnerName ?? '?'}`;
    case 'job_waiting_approval': return `${a.pending ?? 0} approval(s) pending, oldest ${secText(a.oldestSec)}`;
    case 'job_unplaceable': return unplaceableText(a);
    default: return (a.conditions ?? []).map(conditionText).join('; ');
  }
}

export function printStatus(d: FleetDashboardDto, now: Date = new Date()): void {
  const c = d.counts;
  console.log(`runners ${c.runnersOnline}/${c.runnersTotal} online · queued ${c.queued} · running ${c.running} · attention ${c.attention}`);
  if (d.attention.length === 0) {
    console.log('All clear');
    return;
  }
  table(['Severity', 'Since', 'Subject', 'Project', 'Attention'], d.attention.map((a) => [
    a.severity, ago(a.since, now), escapeControls(a.subjectName), a.projectSlug ?? '-', escapeControls(describeAttention(a)),
  ]));
}

async function fetchDashboard(o: StatusOptions): Promise<FleetDashboardDto> {
  if (o.allProjects) {
    await withContext({}, { requireProject: false });
    return unwrap<FleetDashboardDto>(await fleetDashboardControllerGet());
  }
  const { projectSlug: slug } = await withContext({ projectSlug: o.project });
  return unwrap<FleetDashboardDto>(await projectFleetDashboardControllerGet({ path: { slug } }));
}

/** `koda fleet status` (S2b (c) §3, D409). */
export function registerFleetStatus(fleet: Command): void {
  fleet
    .command('status')
    .description('Fleet health: runner and job counts and what needs attention')
    .option('--project <slug>', 'Project slug (uses config if not provided)')
    .option('--all-projects', 'Across every project (global admin)')
    .option('--json', 'Output as JSON')
    .action(async (o: StatusOptions) => {
      if (o.allProjects && o.project) return handleFleetValidation('--all-projects and --project cannot be combined');
      try {
        const d = await fetchDashboard(o);
        if (o.json) console.log(JSON.stringify(d, null, 2));
        else printStatus(d);
        process.exit(0);
      } catch (err: unknown) {
        handleApiError(err, o.allProjects ? { forbiddenHint: ADMIN_TOKEN_HINT } : undefined);
      }
    });
}
