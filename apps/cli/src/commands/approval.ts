import { Command, InvalidArgumentError } from 'commander';
import {
  approvalRequestsControllerCancel, approvalRequestsControllerDecide, approvalRequestsControllerGet,
  approvalRequestsControllerList, projectsControllerFindBySlug,
  approvalPoliciesControllerList, approvalPoliciesControllerKeys, approvalPoliciesControllerCreate, approvalPoliciesControllerUpdate, approvalPoliciesControllerRemove,
  projectApprovalPoliciesControllerList, projectApprovalPoliciesControllerKeys, projectApprovalPoliciesControllerCreate, projectApprovalPoliciesControllerUpdate, projectApprovalPoliciesControllerRemove,
  agentsControllerFindBySlug,
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

function parsePageSize(value: string): number {
  const size = parsePositiveInt(value);
  if (size > 100) throw new InvalidArgumentError('must be between 1-100');
  return size;
}

function registerList(approval: Command): void {
  approval.command('list').description('List approval requests')
    .option('--status <status>', 'Request status').option('--project <slug>', 'Filter by project slug')
    .option('--key <permissionKey>', 'Filter by permission key').option('--mine', 'Only requests you opened')
    .option('--page <n>', 'Page number', parsePositiveInt, 1).option('--size <n>', 'Page size (1-100)', parsePageSize, 20)
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

interface PolicyOptions { project?: string; pattern?: string; page: number; size: number; json?: boolean }
function subjectLabel(r: RecordValue): string {
  if (r.roleId) return `role:${String(r.roleId)}`;
  if (r.principalId) return `${String(r.principalType ?? '')}:${String(r.principalId)}`;
  if (r.principalType) return `type:${String(r.principalType)}`;
  return 'all';
}
async function routeCall<T>(project: string | undefined, globalCall: (arg: never) => Promise<unknown>, projectCall: (arg: never) => Promise<unknown>, arg: Record<string, unknown>): Promise<T> {
  const response = project === undefined ? await globalCall(arg as never) : await projectCall({ ...arg, path: { slug: project, ...(typeof arg.path === 'object' && arg.path !== null ? arg.path as Record<string, unknown> : {}) } } as never);
  return unwrap<T>(response);
}
function registerPolicies(approval: Command): void {
  const policy = approval.command('policy').description('Manage approval policies');
  policy.command('list').option('--project <slug>').option('--pattern <pattern>').option('--page <n>', 'Page number', parsePositiveInt, 1).option('--size <n>', 'Page size', parsePageSize, 20).option('--json')
    .action(async (options: PolicyOptions) => { try {
      await context(); const query = { current: options.page, size: options.size, ...(options.pattern !== undefined ? { permissionPattern: options.pattern } : {}) };
      const page = await routeCall<{ records: RecordValue[]; hasNext?: boolean; current?: number }>(options.project, approvalPoliciesControllerList as never, projectApprovalPoliciesControllerList as never, { query });
      if (options.json) console.log(JSON.stringify(page, null, 2)); else { table(['ID', 'Pattern', 'Applies to', 'Mode', 'Project', 'Timeout'], page.records.map(r => [String(r.id ?? ''), String(r.permissionPattern ?? ''), subjectLabel(r), String(r.mode ?? ''), String(r.projectId ?? 'global'), String(r.timeoutSec ?? '')])); if (page.hasNext) console.log(`Next: --page ${(page.current ?? options.page) + 1}`); }
      process.exit(0);
    } catch (err: unknown) { handleApiError(err); } });
  policy.command('keys').option('--project <slug>').option('--json').action(async (options: { project?: string; json?: boolean }) => { try {
    await context(); const data = await routeCall<RecordValue>(options.project, approvalPoliciesControllerKeys as never, projectApprovalPoliciesControllerKeys as never, {}); const keys = Array.isArray(data.keys) ? data.keys : [];
    if (options.json) console.log(JSON.stringify(data, null, 2)); else table(['Key', 'Scope', 'Risk', 'Floor', 'Default'], keys.map(k => { const r = record(k); return [String(r.key ?? ''), String(r.scope ?? ''), String(r.risk ?? ''), String(r.floor ?? ''), String(r.default ?? '')]; })); process.exit(0);
  } catch (err: unknown) { handleApiError(err); } });
  policy.command('set').requiredOption('--pattern <pattern>').requiredOption('--mode <mode>').option('--project <slug>').option('--type <type>').option('--role <roleId>').option('--user <userId>').option('--agent <agentSlug>').option('--timeout <sec>', 'Timeout in seconds', parsePositiveInt).option('--on-timeout <behavior>').option('--approver-need-not-hold').option('--distinct-approver').option('--json')
    .action(async (options: Record<string, unknown>) => {
      const selected = ['type', 'role', 'user', 'agent'].filter(k => options[k] !== undefined);
      if (selected.length > 1) { handleApiError(new Error('Choose at most one of --type, --role, --user or --agent'), { validationError: true }); return; }
      try {
        await context(); let appliesTo: RecordValue = { kind: 'all' };
        if (options.type) appliesTo = { kind: 'type', principalType: options.type };
        if (options.role) appliesTo = { kind: 'role', roleId: options.role };
        if (options.user) appliesTo = { kind: 'principal', principalType: 'USER', principalId: options.user };
        if (options.agent) { const agent = unwrap<RecordValue>(await agentsControllerFindBySlug({ path: { slug: String(options.agent) } })); appliesTo = { kind: 'principal', principalType: 'AGENT', principalId: agent.id }; }
        const body: RecordValue = { permissionPattern: options.pattern, mode: options.mode, appliesTo };
        if (options.timeout !== undefined) body.timeoutSec = options.timeout;
        if (options.onTimeout !== undefined) body.onTimeout = options.onTimeout;
        if (options.approverNeedNotHold) body.approverMustHoldAction = false;
        if (options.distinctApprover) body.requireDistinctApprover = true;
        const result = await routeCall<RecordValue>(options.project as string | undefined, approvalPoliciesControllerCreate as never, projectApprovalPoliciesControllerCreate as never, { body });
        if (options.json) console.log(JSON.stringify(result, null, 2)); else console.log(`Set policy ${String(result.id ?? '')}: ${String(options.pattern)} ${String(options.mode)}`); process.exit(0);
      } catch (err: unknown) { handleApiError(err); }
    });
  policy.command('update <id>').option('--project <slug>').option('--mode <mode>').option('--timeout <sec>', 'Timeout in seconds', parsePositiveInt).option('--no-timeout').option('--on-timeout <behavior>').option('--json')
    .action(async (id: string, options: Record<string, unknown>) => {
      const body: RecordValue = {}; if (options.mode !== undefined) body.mode = options.mode; if (options.timeout === false) body.timeoutSec = null; else if (options.timeout !== undefined) body.timeoutSec = options.timeout; if (options.onTimeout !== undefined) body.onTimeout = options.onTimeout;
      if (!Object.keys(body).length) { handleApiError(new Error('Nothing to update'), { validationError: true }); return; }
      try { await context(); const result = await routeCall<RecordValue>(options.project as string | undefined, approvalPoliciesControllerUpdate as never, projectApprovalPoliciesControllerUpdate as never, { path: { id }, body }); if (options.json) console.log(JSON.stringify(result, null, 2)); else console.log(`Updated policy ${id}`); process.exit(0); } catch (err: unknown) { handleApiError(err); }
    });
  policy.command('delete <id>').option('--project <slug>').option('--json').action(async (id: string, options: { project?: string; json?: boolean }) => {
    try {
      await context();
      // DELETE returns HTTP 204 without a JSON envelope to unwrap.
      if (options.project === undefined) await approvalPoliciesControllerRemove({ path: { id } });
      else await projectApprovalPoliciesControllerRemove({ path: { slug: options.project, id } });
      if (options.json) console.log(JSON.stringify({ deleted: id }, null, 2));
      else console.log(`Deleted policy ${id}`);
      process.exit(0);
    } catch (err: unknown) { handleApiError(err); }
  });
}

export function approvalCommand(program: Command): void {
  const approval = program.command('approval').description('Manage approval requests');
  registerList(approval); registerShow(approval); registerDecision(approval, 'approve'); registerDecision(approval, 'reject'); registerCancel(approval); registerPolicies(approval);
}
