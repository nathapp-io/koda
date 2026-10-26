import { Command } from 'commander';
import {
  approvalRequestsControllerCancel, approvalRequestsControllerDecide, approvalRequestsControllerGet,
  approvalRequestsControllerList, projectsControllerFindBySlug,
  type ApprovalRequestsControllerListData,
} from '../generated';
import { unwrap } from '../utils/api';
import { withContext } from '../utils/context';
import { handleApiError } from '../utils/error';
import { table } from '../utils/output';
import { parsePositiveInt } from '../utils/parse-positive-int';

interface ApprovalOptions {
  status?: 'pending' | 'executed' | 'cancelled' | 'approved' | 'rejected' | 'expired' | 'failed'; project?: string; key?: string; mine?: boolean; page: number; size: number; json?: boolean; comment?: string;
}
type RecordValue = Record<string, unknown>;
interface RequestPage { records: RecordValue[]; hasNext?: boolean }
const SUMMARY_FIELDS = ['id', 'permissionKey', 'projectId', 'actorType', 'actorId', 'onBehalfOfType', 'onBehalfOfId', 'origin', 'requiredMode', 'status', 'satisfiedBy', 'approverType', 'approverId', 'expiresAt', 'decidedAt', 'settledAt', 'createdAt'] as const;

async function context() {
  return withContext({}, { requireProject: false });
}
function record(value: unknown): RecordValue {
  if (typeof value !== 'object' || value === null) return {};
  return value as RecordValue;
}

function registerList(approval: Command): void {
  approval.command('list').description('List approval requests')
    .option('--status <status>', 'Request status').option('--project <slug>', 'Filter by project slug')
    .option('--key <permissionKey>', 'Filter by permission key').option('--mine', 'Only requests you opened')
    .option('--page <n>', 'Page number', parsePositiveInt, 1).option('--size <n>', 'Page size', parsePositiveInt, 20)
    .option('--json', 'Output as JSON').action(async (options: ApprovalOptions) => {
      try {
        await context();
        const projectId = options.project === undefined ? undefined : record(unwrap(await projectsControllerFindBySlug({ path: { slug: options.project } }))).id;
        const query: NonNullable<ApprovalRequestsControllerListData['query']> = { current: options.page, size: options.size,
          ...(options.status !== undefined ? { status: options.status } : {}),
          ...(projectId !== undefined ? { projectId: String(projectId) } : {}),
          ...(options.key !== undefined ? { permissionKey: options.key } : {}), ...(options.mine ? { mine: true } : {}) };
        const page = unwrap<RequestPage>(await approvalRequestsControllerList({ query }));
        if (options.json) console.log(JSON.stringify(page, null, 2));
        else {
          table(['ID', 'Status', 'Key', 'Project', 'Actor', 'Requires', 'Expires'], page.records.map((r) => [
            String(r.id ?? ''), String(r.status ?? ''), String(r.permissionKey ?? ''), String(r.projectId ?? 'global'),
            `${String(r.actorType ?? '')}/${String(r.actorId ?? '')}`, String(r.requiredMode ?? ''), String(r.expiresAt ?? ''),
          ]));
          if (page.hasNext) console.log(`Next: --page ${options.page + 1}`);
        }
        process.exit(0);
      } catch (err: unknown) { handleApiError(err); }
    });
}

function registerShow(approval: Command): void {
  approval.command('show <id>').description('Show an approval request').option('--json', 'Output as JSON')
    .action(async (id: string, options: { json?: boolean }) => {
      try {
        await context();
        const detail = unwrap<RecordValue>(await approvalRequestsControllerGet({ path: { id } }));
        if (options.json) console.log(JSON.stringify(detail, null, 2));
        else {
          for (const field of SUMMARY_FIELDS) console.log(`${field}: ${String(detail[field] ?? '')}`);
          console.log('input:');
          for (const line of JSON.stringify(detail.input, null, 2).split('\n')) console.log(`  ${line}`);
          const decisions = Array.isArray(detail.decisions) ? detail.decisions : [];
          for (const item of decisions) {
            const d = record(item);
            console.log(`${String(d.decidedAt ?? '')} ${String(d.decision ?? '')} by ${String(d.deciderType ?? '')}/${String(d.deciderId ?? '')}${d.comment ? `: ${String(d.comment)}` : ''}`);
          }
        }
        process.exit(0);
      } catch (err: unknown) { handleApiError(err); }
    });
}

function registerDecision(approval: Command, decision: 'approve' | 'reject'): void {
  approval.command(decision + ' <id>').description(`${decision === 'approve' ? 'Approve' : 'Reject'} an approval request`)
    .option('--comment <text>', 'Optional comment').option('--json', 'Output as JSON')
    .action(async (id: string, options: { comment?: string; json?: boolean }) => {
      try {
        await context();
        const response = unwrap<RecordValue>(await approvalRequestsControllerDecide({ path: { id }, body: { decision, ...(options.comment !== undefined ? { comment: options.comment } : {}) } }));
        if (options.json) console.log(JSON.stringify(response, null, 2)); else console.log(`${id} ${String(response.status ?? '')}`);
        process.exit(0);
      } catch (err: unknown) { handleApiError(err); }
    });
}
function registerCancel(approval: Command): void {
  approval.command('cancel <id>').description('Cancel an approval request').option('--json', 'Output as JSON')
    .action(async (id: string, options: { json?: boolean }) => {
      try {
        await context();
        const response = unwrap<RecordValue>(await approvalRequestsControllerCancel({ path: { id } }));
        if (options.json) console.log(JSON.stringify(response, null, 2)); else console.log(`${id} ${String(response.status ?? '')}`);
        process.exit(0);
      } catch (err: unknown) { handleApiError(err); }
    });
}

export function approvalCommand(program: Command): void {
  const approval = program.command('approval').description('Manage approval requests');
  registerList(approval); registerShow(approval); registerDecision(approval, 'approve'); registerDecision(approval, 'reject'); registerCancel(approval);
}
