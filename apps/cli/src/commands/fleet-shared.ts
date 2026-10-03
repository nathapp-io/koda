import { InvalidArgumentError } from 'commander';
import {
  projectFleetReposControllerList,
  projectFleetRunnersControllerList,
  type DispatchResultDto,
  type FleetRepoDto,
  type RunnerSummaryDto,
} from '../generated';
import { unwrap } from '../utils/api';
import { handleApiError } from '../utils/error';
import { table } from '../utils/output';

export interface FleetPage<T> {
  total: number;
  current: number;
  size: number;
  hasNext: boolean;
  records: T[];
}

// Agent API keys never hold the global ADMIN authority; runner and repo-registry routes need a
// global-admin user's access token passed through KODA_API_KEY (same as `koda user`).
export const ADMIN_TOKEN_HINT = 'Requires a global-admin user access token: KODA_API_KEY=<token> koda fleet …';

/** Compact age of an ISO instant: 42s, 5m, 3h, 2d; '-' when absent or unparseable. */
export function ago(iso: string | null | undefined, now: Date = new Date()): string {
  if (!iso) return '-';
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return '-';
  const sec = Math.max(0, Math.floor((now.getTime() - at) / 1000));
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m`;
  if (sec < 86_400) return `${Math.floor(sec / 3600)}h`;
  return `${Math.floor(sec / 86_400)}d`;
}

export function pageHint(page: FleetPage<unknown>): string | null {
  return page.hasNext ? `Next: --page ${page.current + 1}` : null;
}

/** `owner/name`, where a GitLab owner may contain `/` (group/subgroup): the name is the last segment. */
export function splitRepoPath(path: string): { owner: string; name: string } | null {
  const cut = path.lastIndexOf('/');
  if (cut <= 0 || cut === path.length - 1) return null;
  const owner = path.slice(0, cut);
  if (owner.split('/').some((part) => part === '')) return null;
  return { owner, name: path.slice(cut + 1) };
}

async function allProjectRecords<T>(fetchPage: (current: number) => Promise<unknown>): Promise<T[]> {
  const records: T[] = [];
  for (let current = 1; ; ) {
    const page = unwrap<FleetPage<T>>(await fetchPage(current));
    records.push(...page.records);
    if (!page.hasNext) break;
    current = page.current + 1;
  }
  return records;
}

async function projectRepos(slug: string): Promise<FleetRepoDto[]> {
  return allProjectRecords<FleetRepoDto>((current) =>
    projectFleetReposControllerList({ path: { slug }, query: { size: 100, ...(current > 1 ? { current } : {}) } }));
}

async function projectRunners(slug: string): Promise<RunnerSummaryDto[]> {
  return allProjectRecords<RunnerSummaryDto>((current) =>
    projectFleetRunnersControllerList({ path: { slug }, query: { size: 100, ...(current > 1 ? { current } : {}) } }));
}

/** A project repo by id, or by `owner/name` (case-insensitive, D133). */
export async function resolveRepo(slug: string, ref: string): Promise<FleetRepoDto | null> {
  const wanted = ref.toLowerCase();
  return (await projectRepos(slug)).find((r) => r.id === ref || `${r.owner}/${r.name}`.toLowerCase() === wanted) ?? null;
}

/** A runner by id or by name (D133). */
export async function resolveRunner(slug: string, ref: string): Promise<RunnerSummaryDto | null> {
  return (await projectRunners(slug)).find((r) => r.id === ref || r.name === ref) ?? null;
}

export async function runnerNames(slug: string): Promise<ReadonlyMap<string, string>> {
  return new Map((await projectRunners(slug)).map((r) => [r.id, r.name]));
}

/** `runnerNames` after a successful action (dispatch, requeue): an empty map when the lookup fails, so the job line still prints. */
export async function runnerNamesOrEmpty(slug: string): Promise<ReadonlyMap<string, string>> {
  try {
    return await runnerNames(slug);
  } catch {
    return new Map();
  }
}

/** `owner/name` by repo id, for tables; an empty map when the lookup fails, so the table still prints ids. */
export async function repoNamesOrEmpty(slug: string): Promise<ReadonlyMap<string, string>> {
  try {
    return new Map((await projectRepos(slug)).map((r): [string, string] => [r.id, `${r.owner}/${r.name}`]));
  } catch {
    return new Map();
  }
}

export function handleFleetValidation(message: string): never {
  return handleApiError(message, { validationError: true });
}

/** S1.5 §1.6: gated/escalate relay nax's bash asks to the koda approvals inbox (RUN jobs only). */
export type BashMode = 'raw' | 'gated' | 'escalate';
const BASH_MODES: readonly BashMode[] = ['raw', 'gated', 'escalate'];

export function parseBashMode(value: string): BashMode {
  if (!(BASH_MODES as readonly string[]).includes(value)) throw new InvalidArgumentError('expected raw, gated or escalate');
  return value as BashMode;
}

/** 30..3600 whole seconds (DispatchFleetJobDto.approvalTimeoutSec). */
export function parseApprovalTimeout(value: string): number {
  if (!/^\d{2,4}$/.test(value) || Number(value) < 30 || Number(value) > 3600) {
    throw new InvalidArgumentError('expected a whole number of seconds from 30 to 3600');
  }
  return Number(value);
}

export const bashModeText = (mode: BashMode, sec: number): string => (mode === 'raw' ? 'raw' : `${mode} (asks wait ${sec} s)`);

/** D301: a timeout means nothing without a relay mode; a PLAN job stays raw. Returns the refusal, or null. */
export function bashFlagProblem(o: { bashMode?: BashMode; approvalTimeout?: number; plan?: string }): string | null {
  const relay = o.bashMode !== undefined && o.bashMode !== 'raw';
  if (relay && o.plan) return '--bash-mode gated/escalate applies to nax run only: a --plan job stays raw';
  if (o.approvalTimeout !== undefined && !relay) return '--approval-timeout needs --bash-mode gated or escalate';
  return null;
}

export function handleFleetConflict(message: string): never {
  return handleApiError({ status: 409, message });
}

/** Dispatch and requeue answer: the job, and either its runner or why no runner fits now. */
export function printPlacement(result: DispatchResultDto, names: ReadonlyMap<string, string>): void {
  console.log(`Job ${result.job.id} ${result.job.state}`);
  const { placement } = result;
  if (placement.assigned && placement.runnerId) {
    console.log(`Assigned to ${names.get(placement.runnerId) ?? placement.runnerId}`);
    return;
  }
  console.log('Queued: no runner fits now');
  if (placement.misfits.length > 0) {
    table(['Runner', 'Reason'], placement.misfits.map((m) => [m.name, m.reason]));
  }
}
