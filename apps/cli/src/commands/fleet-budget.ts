import { Command, InvalidArgumentError } from 'commander';
import {
  fleetBudgetsControllerCreate,
  fleetBudgetsControllerList,
  fleetBudgetsControllerRemove,
  fleetBudgetsControllerResume,
  fleetBudgetsControllerUpdate,
  projectFleetBudgetsControllerCreate,
  projectFleetBudgetsControllerList,
  projectFleetBudgetsControllerRemove,
  projectFleetBudgetsControllerResume,
  projectFleetBudgetsControllerUpdate,
  type BudgetPolicyDto,
  type CreateBudgetPolicyDto,
  type ResumeBudgetPolicyDto,
  type UpdateBudgetPolicyDto,
} from '../generated';
import { unwrap } from '../utils/api';
import { withContext } from '../utils/context';
import { handleApiError } from '../utils/error';
import { requireForce } from '../utils/force';
import { table } from '../utils/output';
import { parseBudgetUsd } from '../utils/parse-usd';
import { ADMIN_TOKEN_HINT, handleFleetValidation, resolveRepo } from './fleet-shared';

type WindowKind = 'calendar_month_utc' | 'lifetime';
type Scope =
  | { scopeType: 'global' }
  | { scopeType: 'project' }
  | { scopeType: 'runner'; ref: string }
  | { scopeType: 'repo'; ref: string };

/** `global`, `project`, `runner:<id>` or `repo:<id or owner/name>` (S1b §2.1 scopes). */
export function parseScope(value: string): Scope {
  if (value === 'global' || value === 'project') return { scopeType: value };
  const cut = value.indexOf(':');
  const kind = cut > 0 ? value.slice(0, cut) : '';
  const ref = cut > 0 ? value.slice(cut + 1) : '';
  if ((kind === 'runner' || kind === 'repo') && ref !== '') return { scopeType: kind, ref };
  throw new InvalidArgumentError('expected global, project, runner:<id> or repo:<id or owner/name>');
}

export function parseWindow(value: string): WindowKind {
  if (value === 'month') return 'calendar_month_utc';
  if (value === 'lifetime') return 'lifetime';
  throw new InvalidArgumentError('expected month or lifetime');
}

export type WarnOption = number | 'none';

/** 1-99, or `none` (no warn). Returns the string 'none', never null: commander turns a null parser result into ''. */
export function parseWarn(value: string): WarnOption {
  if (value === 'none') return 'none';
  if (!/^\d{1,2}$/.test(value) || Number(value) < 1) throw new InvalidArgumentError('expected 1-99 or none');
  return Number(value);
}

export function parseOnOff(value: string): boolean {
  if (value === 'on' || value === 'off') return value === 'on';
  throw new InvalidArgumentError('expected on or off');
}

export function parseRunning(value: string): 'finish' | 'cancel' {
  if (value === 'finish' || value === 'cancel') return value;
  throw new InvalidArgumentError('expected finish or cancel');
}

export function budgetState(p: BudgetPolicyDto): string {
  if (p.paused) return 'PAUSED';
  return p.warnReached ? 'WARN' : 'ok';
}

const scopeLabel = (p: BudgetPolicyDto): string => (p.scopeId ? `${p.scopeType}:${p.scopeId}` : p.scopeType);
const windowLabel = (p: BudgetPolicyDto): string => (p.windowKind === 'lifetime' ? 'lifetime' : 'month');
const adminHint = (project: string | undefined) => (project === undefined ? { forbiddenHint: ADMIN_TOKEN_HINT } : undefined);

/** The ten budget operations behind one shape: the global-admin routes or one project's routes. */
interface BudgetApi {
  list(): Promise<unknown>;
  create(body: CreateBudgetPolicyDto): Promise<unknown>;
  update(id: string, body: UpdateBudgetPolicyDto): Promise<unknown>;
  remove(id: string): Promise<unknown>;
  resume(id: string, body: ResumeBudgetPolicyDto): Promise<unknown>;
}

const ADMIN_API: BudgetApi = {
  list: () => fleetBudgetsControllerList(),
  create: (body) => fleetBudgetsControllerCreate({ body }),
  update: (id, body) => fleetBudgetsControllerUpdate({ path: { id }, body }),
  remove: (id) => fleetBudgetsControllerRemove({ path: { id } }),
  resume: (id, body) => fleetBudgetsControllerResume({ path: { id }, body }),
};

const projectApi = (slug: string): BudgetApi => ({
  list: () => projectFleetBudgetsControllerList({ path: { slug } }),
  create: (body) => projectFleetBudgetsControllerCreate({ path: { slug }, body }),
  update: (id, body) => projectFleetBudgetsControllerUpdate({ path: { slug, id }, body }),
  remove: (id) => projectFleetBudgetsControllerRemove({ path: { slug, id } }),
  resume: (id, body) => projectFleetBudgetsControllerResume({ path: { slug, id }, body }),
});

/** `--project` selects the project routes; without it, the global-admin routes. */
async function routeFor(project: string | undefined): Promise<BudgetApi> {
  if (project !== undefined) return projectApi((await withContext({ projectSlug: project })).projectSlug);
  await withContext({}, { requireProject: false });
  return ADMIN_API;
}

function printRow(verb: string, p: BudgetPolicyDto): void {
  console.log(`${verb} budget ${p.id}: ${scopeLabel(p)} ${windowLabel(p)}, spent $${p.spentUsd} of $${p.amountUsd} (${budgetState(p)})`);
}

function registerList(budget: Command): void {
  budget
    .command('list')
    .description("Budget policies with this window's spend (--project: the project's and the global ones; otherwise all, global admin)")
    .option('--project <slug>', 'Use the project routes')
    .option('--json', 'Output as JSON')
    .action(async (options: { project?: string; json?: boolean }) => {
      try {
        const rows = unwrap<BudgetPolicyDto[]>(await (await routeFor(options.project)).list());
        if (options.json) {
          console.log(JSON.stringify(rows, null, 2));
        } else {
          table(['ID', 'Scope', 'Window', 'Spent / Amount', 'Warn', 'Hard stop', 'State'], rows.map((p) => [
            p.id, scopeLabel(p), windowLabel(p), `$${p.spentUsd} / $${p.amountUsd}`,
            p.warnPercent === null ? '-' : `${p.warnPercent}%`, p.hardStop ? p.runningJobs : 'off', budgetState(p),
          ]));
        }
        process.exit(0);
      } catch (err: unknown) {
        handleApiError(err, adminHint(options.project));
      }
    });
}

interface SetOptions {
  scope: Scope;
  window: WindowKind;
  amount: number;
  warn?: WarnOption;
  hardStop?: boolean;
  running?: 'finish' | 'cancel';
  project?: string;
  json?: boolean;
}

function registerSet(budget: Command): void {
  budget
    .command('set')
    .description('Create or update the policy of a scope and window (global, runner: global admin; project, repo: project admin)')
    .requiredOption('--scope <scope>', 'global, project, runner:<id> or repo:<id or owner/name>', parseScope)
    .requiredOption('--window <window>', 'month (calendar month, UTC) or lifetime', parseWindow)
    .requiredOption('--amount <usd>', 'Amount in USD, at most 4 decimals', parseBudgetUsd)
    .option('--warn <percent>', 'Warn at this percent (1-99) or none; 80 when a new policy omits it', parseWarn)
    .option('--hard-stop <on|off>', 'Pause the scope when spend reaches the amount; on when a new policy omits it', parseOnOff)
    .option('--running <finish|cancel>', 'At a hard stop, let running jobs finish or cancel them; finish when omitted', parseRunning)
    .option('--project <slug>', 'Project slug for project and repo scopes (uses config if not provided)')
    .option('--json', 'Output as JSON')
    .action(async (options: SetOptions) => {
      const { scope } = options;
      const projectScoped = scope.scopeType === 'project' || scope.scopeType === 'repo';
      try {
        let api: BudgetApi;
        let scopeId: string | undefined;
        if (projectScoped) {
          const ctx = await withContext({ projectSlug: options.project });
          api = projectApi(ctx.projectSlug);
          if (scope.scopeType === 'repo') {
            const repo = await resolveRepo(ctx.projectSlug, scope.ref);
            if (!repo) return handleFleetValidation(`No fleet repo "${scope.ref}" in project ${ctx.projectSlug}`);
            scopeId = repo.id;
          }
        } else {
          await withContext({}, { requireProject: false });
          api = ADMIN_API;
          if (scope.scopeType === 'runner') scopeId = scope.ref;
        }
        const fields: UpdateBudgetPolicyDto = {
          amountUsd: options.amount,
          ...(options.warn !== undefined ? { warnPercent: options.warn === 'none' ? null : options.warn } : {}),
          ...(options.hardStop !== undefined ? { hardStop: options.hardStop } : {}),
          ...(options.running !== undefined ? { runningJobs: options.running } : {}),
        };
        const existing = unwrap<BudgetPolicyDto[]>(await api.list()).find((p) =>
          p.scopeType === scope.scopeType && p.windowKind === options.window && (scope.scopeType === 'project' || (p.scopeId ?? undefined) === scopeId));
        const saved = existing
          ? unwrap<BudgetPolicyDto>(await api.update(existing.id, fields))
          : unwrap<BudgetPolicyDto>(await api.create({ scopeType: scope.scopeType, ...(scopeId ? { scopeId } : {}), windowKind: options.window, ...fields, amountUsd: options.amount }));
        if (options.json) console.log(JSON.stringify(saved, null, 2));
        else printRow(existing ? 'Updated' : 'Created', saved);
        process.exit(0);
      } catch (err: unknown) {
        handleApiError(err, projectScoped ? undefined : { forbiddenHint: ADMIN_TOKEN_HINT });
      }
    });
}

function registerRemove(budget: Command): void {
  budget
    .command('rm <policyId>')
    .description('Delete a budget policy; lifts its pause')
    .option('--project <slug>', 'Use the project routes (project and repo policies)')
    .option('--force', 'Confirm the deletion')
    .action(async (policyId: string, options: { project?: string; force?: boolean }) => {
      if (!requireForce(options.force)) return;
      try {
        await (await routeFor(options.project)).remove(policyId);
        console.log(`Removed budget ${policyId}`);
        process.exit(0);
      } catch (err: unknown) {
        handleApiError(err, { ...adminHint(options.project), notFoundMessage: `Budget policy not found: ${policyId}` });
      }
    });
}

function registerResume(budget: Command): void {
  budget
    .command('resume <policyId>')
    .description("Resume a paused policy, optionally raising the amount above this window's spend")
    .option('--amount <usd>', 'New amount in USD', parseBudgetUsd)
    .option('--project <slug>', 'Use the project routes (project and repo policies)')
    .option('--json', 'Output as JSON')
    .action(async (policyId: string, options: { amount?: number; project?: string; json?: boolean }) => {
      try {
        const api = await routeFor(options.project);
        const resumed = unwrap<BudgetPolicyDto>(await api.resume(policyId, options.amount === undefined ? {} : { amountUsd: options.amount }));
        if (options.json) console.log(JSON.stringify(resumed, null, 2));
        else printRow('Resumed', resumed);
        process.exit(0);
      } catch (err: unknown) {
        handleApiError(err, { ...adminHint(options.project), notFoundMessage: `Budget policy not found: ${policyId}` });
      }
    });
}

/** `koda fleet budget …`: C1 spend caps per scope (S1b §2.4, plan D169). */
export function registerFleetBudget(fleet: Command): void {
  const budget = fleet.command('budget');
  budget.description('Fleet budget policies: spend caps per global, project, repo or runner scope');
  registerList(budget);
  registerSet(budget);
  registerRemove(budget);
  registerResume(budget);
}
