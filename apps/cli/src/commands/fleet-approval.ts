import { Command, InvalidArgumentError } from 'commander';
import {
  fleetApprovalsControllerDecide,
  fleetApprovalsControllerGet,
  fleetApprovalsControllerList,
  projectFleetApprovalsControllerDecide,
  projectFleetApprovalsControllerGet,
  projectFleetApprovalsControllerList,
  type DecideApprovalDto,
  type FleetApprovalDto,
  type FleetApprovalsControllerListData,
} from '../generated';
import { unwrap } from '../utils/api';
import { withContext } from '../utils/context';
import { handleApiError } from '../utils/error';
import { table } from '../utils/output';
import { parseBudgetUsd } from '../utils/parse-usd';
import { ADMIN_TOKEN_HINT, type FleetPage } from './fleet-shared';

/** The generated list filters, so the two routes share one query shape and nothing is cast. */
type ListQuery = NonNullable<FleetApprovalsControllerListData['query']>;
type ApprovalStatus = NonNullable<ListQuery['status']>;
type ApprovalType = NonNullable<ListQuery['type']>;

/** The three approval operations behind one shape: the global-admin routes or one project's routes. */
interface ApprovalApi {
  list(query: ListQuery): Promise<unknown>;
  get(id: string): Promise<unknown>;
  decide(id: string, body: DecideApprovalDto): Promise<unknown>;
}
interface RequeueResult { jobId: string; ok: boolean; error?: string }

const ADMIN_API: ApprovalApi = {
  list: (query) => fleetApprovalsControllerList({ query }),
  get: (id) => fleetApprovalsControllerGet({ path: { id } }),
  decide: (id, body) => fleetApprovalsControllerDecide({ path: { id }, body }),
};

const projectApi = (slug: string): ApprovalApi => ({
  list: (query) => projectFleetApprovalsControllerList({ path: { slug }, query }),
  get: (id) => projectFleetApprovalsControllerGet({ path: { slug, id } }),
  decide: (id, body) => projectFleetApprovalsControllerDecide({ path: { slug, id }, body }),
});

/** `--project` selects the project routes; without it, the global-admin routes (plan D238). */
async function routeFor(project: string | undefined): Promise<ApprovalApi> {
  if (project !== undefined) return projectApi((await withContext({ projectSlug: project })).projectSlug);
  await withContext({}, { requireProject: false });
  return ADMIN_API;
}

const adminHint = (project: string | undefined) => (project === undefined ? { forbiddenHint: ADMIN_TOKEN_HINT } : undefined);

export function parseRequeue(value: string): 'all' | string[] {
  if (value === 'all') return 'all';
  const ids = value.split(',').map((s) => s.trim()).filter((s) => s !== '');
  if (ids.length === 0) throw new InvalidArgumentError('expected all or a comma-separated list of job ids');
  return ids;
}

/** D236: a bash approval is not decidable in this slice, so only the two budget decisions are offered. */
function parseDecision(value: string): DecideApprovalDto['decision'] {
  if (value === 'keep_paused' || value === 'raise_budget_and_resume') return value;
  throw new InvalidArgumentError('expected keep_paused or raise_budget_and_resume');
}

const APPROVAL_STATUSES: ApprovalStatus[] = ['pending', 'approved', 'rejected', 'expired', 'cancelled'];
const APPROVAL_TYPES: ApprovalType[] = ['budget_override_required', 'nax_bash_escalate'];

export function parseStatus(value: string): ApprovalStatus {
  if ((APPROVAL_STATUSES as string[]).includes(value)) return value as ApprovalStatus;
  throw new InvalidArgumentError(`expected ${APPROVAL_STATUSES.join(', ')}`);
}

export function parseType(value: string): ApprovalType {
  if ((APPROVAL_TYPES as string[]).includes(value)) return value as ApprovalType;
  throw new InvalidArgumentError(`expected ${APPROVAL_TYPES.join(', ')}`);
}

/** D237: payload and outcome are free-form JSON, so read them defensively. */
function summary(a: FleetApprovalDto): string {
  const p = a.payload as Record<string, unknown>;
  if (a.type === 'budget_override_required') return `${String(p['scopeType'] ?? '')} spent $${String(p['spentUsd'] ?? '?')} of $${String(p['amountUsd'] ?? '?')}`;
  return String(p['command'] ?? '').slice(0, 60);
}

function printOne(verb: string, a: FleetApprovalDto): void {
  console.log(`${verb} approval ${a.id}: ${a.type} ${a.status}${a.decision ? ` (${a.decision})` : ''}`);
  const results = ((a.outcome as Record<string, unknown> | null)?.['requeueResults'] ?? []) as RequeueResult[];
  if (results.length > 0) {
    console.log(`${results.filter((r) => r.ok).length} of ${results.length} re-queued`);
    for (const r of results.filter((x) => !x.ok)) console.log(`  ${r.jobId}: ${r.error ?? 'failed'}`);
  }
}

function registerList(approval: Command): void {
  approval
    .command('list')
    .description('Approvals, newest first (--project: that project; otherwise all, global admin)')
    .option('--project <slug>', 'Use the project routes')
    .option('--status <status>', 'pending, approved, rejected, expired or cancelled', parseStatus)
    .option('--type <type>', 'budget_override_required or nax_bash_escalate', parseType)
    .option('--json', 'Output as JSON')
    .action(async (options: { project?: string; status?: ApprovalStatus; type?: ApprovalType; json?: boolean }) => {
      try {
        const query: ListQuery = { ...(options.status ? { status: options.status } : {}), ...(options.type ? { type: options.type } : {}) };
        const page = unwrap<FleetPage<FleetApprovalDto>>(await (await routeFor(options.project)).list(query));
        if (options.json) console.log(JSON.stringify(page, null, 2));
        else table(['ID', 'Type', 'Status', 'Requested', 'Summary'], page.records.map((a) => [a.id, a.type, a.status, a.requestedAt, summary(a)]));
        process.exit(0);
      } catch (err: unknown) {
        handleApiError(err, adminHint(options.project));
      }
    });
}

function registerShow(approval: Command): void {
  approval
    .command('show <approvalId>')
    .description('One approval; a pending budget override lists its re-queue candidates')
    .option('--project <slug>', 'Use the project routes')
    .option('--json', 'Output as JSON')
    .action(async (approvalId: string, options: { project?: string; json?: boolean }) => {
      try {
        const a = unwrap<FleetApprovalDto>(await (await routeFor(options.project)).get(approvalId));
        if (options.json) {
          console.log(JSON.stringify(a, null, 2));
        } else {
          printOne('Showing', a);
          for (const c of a.requeueCandidates ?? []) console.log(`  candidate ${c.jobId} ${c.feature}`);
          if (a.requeueCandidatesTruncated) console.log('  (more candidates exist)');
        }
        process.exit(0);
      } catch (err: unknown) {
        handleApiError(err, { ...adminHint(options.project), notFoundMessage: `Approval not found: ${approvalId}` });
      }
    });
}

interface DecideOptions { project?: string; decision: DecideApprovalDto['decision']; amount?: number; requeue?: 'all' | string[]; comment?: string; json?: boolean }

function registerDecide(approval: Command): void {
  approval
    .command('decide <approvalId>')
    .description('Decide a pending budget override: keep it paused, or raise the amount and resume')
    .requiredOption('--decision <decision>', 'keep_paused or raise_budget_and_resume', parseDecision)
    .option('--amount <usd>', 'raise_budget_and_resume: the new amount, above the window spend', parseBudgetUsd)
    .option('--requeue <ids>', 'raise_budget_and_resume: all, or comma-separated candidate job ids; omitted = none', parseRequeue)
    .option('--comment <text>', 'Optional note (at most 1000 characters)')
    .option('--project <slug>', 'Use the project routes')
    .option('--json', 'Output as JSON')
    .action(async (approvalId: string, options: DecideOptions) => {
      try {
        const api = await routeFor(options.project);
        // D231: an omitted requeueJobIds re-queues nothing, so `--requeue all` must send the ids explicitly.
        let requeueJobIds: string[] | undefined;
        if (options.requeue === 'all') {
          const a = unwrap<FleetApprovalDto>(await api.get(approvalId));
          requeueJobIds = (a.requeueCandidates ?? []).map((c) => c.jobId);
          // The API caps the candidate list at 200 (requeueCandidatesTruncated), so `all` means every id
          // the user was shown, not every blocked job. Warn on stderr before deciding, so it survives a
          // refused decide and never lands in --json stdout.
          if (a.requeueCandidatesTruncated) console.error('More candidates exist; only the first 200 are re-queued.');
        } else if (options.requeue !== undefined) {
          requeueJobIds = options.requeue;
        }
        const body: DecideApprovalDto = {
          decision: options.decision,
          ...(options.amount !== undefined ? { amountUsd: options.amount } : {}),
          ...(requeueJobIds !== undefined ? { requeueJobIds } : {}),
          ...(options.comment !== undefined ? { comment: options.comment } : {}),
        };
        const decided = unwrap<FleetApprovalDto>(await api.decide(approvalId, body));
        if (options.json) console.log(JSON.stringify(decided, null, 2));
        else printOne('Decided', decided);
        process.exit(0);
      } catch (err: unknown) {
        handleApiError(err, { ...adminHint(options.project), notFoundMessage: `Approval not found: ${approvalId}` });
      }
    });
}

/** `koda fleet approval …`: S1.5 typed approvals (spec §2.5, plan D238). */
export function registerFleetApproval(fleet: Command): void {
  const approval = fleet.command('approval');
  approval.description('Fleet approvals: budget overrides now, bash command asks from S1.5 slice 2');
  registerList(approval);
  registerShow(approval);
  registerDecide(approval);
}
