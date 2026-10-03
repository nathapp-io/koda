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
import { parsePositiveInt } from '../utils/parse-positive-int';
import { ADMIN_TOKEN_HINT, type FleetPage, pageHint } from './fleet-shared';

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

const DECISIONS = ['allow', 'allow_for_job', 'deny', 'raise_budget_and_resume', 'keep_paused'] as const;

function parseDecision(value: string): DecideApprovalDto['decision'] {
  if (!(DECISIONS as readonly string[]).includes(value)) throw new InvalidArgumentError(`one of ${DECISIONS.join(', ')}`);
  return value as DecideApprovalDto['decision'];
}

const APPROVAL_STATUSES = ['pending', 'approved', 'rejected', 'expired', 'cancelled'] as const satisfies readonly ApprovalStatus[];
const APPROVAL_TYPES = ['budget_override_required', 'nax_bash_escalate'] as const satisfies readonly ApprovalType[];

export function parseStatus(value: string): ApprovalStatus {
  if ((APPROVAL_STATUSES as readonly string[]).includes(value)) return value as ApprovalStatus;
  throw new InvalidArgumentError(`expected ${APPROVAL_STATUSES.join(', ')}`);
}

export function parseType(value: string): ApprovalType {
  if ((APPROVAL_TYPES as readonly string[]).includes(value)) return value as ApprovalType;
  throw new InvalidArgumentError(`expected ${APPROVAL_TYPES.join(', ')}`);
}

/** D237: payload and outcome are free-form JSON, so read them defensively. */
function summary(a: FleetApprovalDto): string {
  const p = a.payload as Record<string, unknown>;
  if (a.type === 'budget_override_required') return `${String(p['scopeType'] ?? '')} spent $${String(p['spentUsd'] ?? '?')} of $${String(p['amountUsd'] ?? '?')}`;
  const command = String(p['command'] ?? '');
  if (command !== '') return command.slice(0, 60);
  // D280: a bash ask whose command was not captured still shows its raw detail, never a blank.
  return String(p['rawDetail'] ?? '').split('\n')[0]?.slice(0, 60) ?? '';
}

/** Plan D280: never the request line (nax does not send it separately and the CLI never rebuilds it). */
function bashLines(p: Record<string, unknown>): string[] {
  const command = typeof p['command'] === 'string' && p['command'] !== '' ? p['command'] : null;
  return [
    ...(command ? ['Command:', ...command.split('\n').map((l) => `  ${l}`)] : ['Detail (not parsed):', ...String(p['rawDetail'] ?? '').split('\n').map((l) => `  ${l}`)]),
    ...(p['commandTruncated'] === true ? ['  (truncated: this ask can only be denied)'] : []),
    ...(typeof p['maskedCount'] === 'number' && p['maskedCount'] > 0 ? [`  ${p['maskedCount']} secret value(s) masked`] : []),
    `Runs in:  ${String(p['root'] ?? '')}`,
    `Stage:    ${String(p['stage'] ?? '')}`,
    `Story:    ${String(p['storyId'] ?? '-')}`,
    `Reason:   ${String(p['reason'] ?? '')}`,
    `Options:  ${Array.isArray(p['options']) ? p['options'].join(', ') : ''}`,
  ];
}

function printOne(verb: string, a: FleetApprovalDto): void {
  console.log(`${verb} approval ${a.id}: ${a.type} ${a.status}${a.decision ? ` (${a.decision})` : ''}`);
  const outcome = a.outcome as Record<string, unknown> | null;
  const results = (outcome?.['requeueResults'] ?? []) as RequeueResult[];
  if (results.length > 0) {
    console.log(`${results.filter((r) => r.ok).length} of ${results.length} re-queued`);
    for (const r of results.filter((x) => !x.ok)) console.log(`  ${r.jobId}: ${r.error ?? 'failed'}`);
  }
  const delivery = outcome?.['delivery'];
  if (delivery !== undefined && delivery !== null) {
    console.log(`Delivery: ${typeof delivery === 'string' ? delivery : JSON.stringify(delivery)}`);
  }
}

interface ListOptions { project?: string; status?: ApprovalStatus; type?: ApprovalType; page: number; size: number; json?: boolean }

function registerList(approval: Command): void {
  approval
    .command('list')
    .description('Approvals, newest first (--project: that project; otherwise all, global admin)')
    .option('--project <slug>', 'Use the project routes')
    .option('--status <status>', `One of ${APPROVAL_STATUSES.join(', ')}`, parseStatus)
    .option('--type <type>', `One of ${APPROVAL_TYPES.join(', ')}`, parseType)
    .option('--page <n>', 'Page number', parsePositiveInt, 1)
    .option('--size <n>', 'Page size (1-100)', parsePositiveInt, 20)
    .option('--json', 'Output as JSON')
    .action(async (options: ListOptions) => {
      try {
        const query: ListQuery = {
          current: options.page, size: options.size,
          ...(options.status ? { status: options.status } : {}), ...(options.type ? { type: options.type } : {}),
        };
        const page = unwrap<FleetPage<FleetApprovalDto>>(await (await routeFor(options.project)).list(query));
        if (options.json) console.log(JSON.stringify(page, null, 2));
        else {
          table(['ID', 'Type', 'Status', 'Requested', 'Summary'], page.records.map((a) => [a.id, a.type, a.status, a.requestedAt, summary(a)]));
          const hint = pageHint(page);
          if (hint) console.log(hint);
        }
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
          if (a.type === 'nax_bash_escalate') {
            for (const line of bashLines(a.payload as Record<string, unknown>)) console.log(line);
            if (a.expiresAt) console.log(`Expires:  ${a.expiresAt}`);
          }
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
    .description('Decide an approval (budget override or bash ask)')
    .requiredOption('--decision <decision>', 'allow, allow_for_job, deny, keep_paused or raise_budget_and_resume', parseDecision)
    .option('--amount <usd>', 'raise_budget_and_resume: the new amount, above the window spend', parseBudgetUsd)
    .option('--requeue <ids>', 'raise_budget_and_resume: all, or comma-separated candidate job ids from `koda fleet approval show <id>`; omitted = none', parseRequeue)
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
          // The API caps the candidate list at MAX_REQUEUE_CANDIDATES (plan D235 / `approvals.service.ts`).
          // A cancelled job is never pruned, so a policy can hold more; the page the CLI can see is the
          // oldest slice of them, and the decide server-side-filters on `finishedAt >= requestedAt`, which
          // filters that whole slice out. `--requeue all` would then send an empty or partial set, the
          // decide would answer 200, and nothing would say so. Refuse instead.
          // The fact goes in the thrown message rather than a separate `console.error`: `handleApiError`
          // owns stderr, and under --json that is a single machine-readable object. A raw line ahead of
          // it would break `JSON.parse(stderr)` for any script. The count is interpolated from the
          // response, never hardcoded, so it cannot drift from MAX_REQUEUE_CANDIDATES.
          if (a.requeueCandidatesTruncated) {
            throw new InvalidArgumentError(
              `too many re-queue candidates to name as \`all\`; \`koda fleet approval show ${approvalId}\` lists only the first ${a.requeueCandidates?.length ?? 0}, so pass their job ids instead. Nothing was decided or resumed.`,
            );
          }
          requeueJobIds = (a.requeueCandidates ?? []).map((c) => c.jobId);
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
