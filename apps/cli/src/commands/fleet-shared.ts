import {
  projectFleetReposControllerList,
  projectFleetRunnersControllerList,
  type DispatchResultDto,
  type FleetRepoDto,
  type RunnerSummaryDto,
} from '../generated';
import { unwrap } from '../utils/api';
import { apiErrorCode } from '../utils/api-error-code';
import { handleApiError } from '../utils/error';
import { error, table } from '../utils/output';

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

// Fleets are a handful of repos and machines (overview D125): one page of 100 is the whole list.
async function projectRepos(slug: string): Promise<FleetRepoDto[]> {
  return unwrap<FleetPage<FleetRepoDto>>(await projectFleetReposControllerList({ path: { slug }, query: { size: 100 } })).records;
}

async function projectRunners(slug: string): Promise<RunnerSummaryDto[]> {
  return unwrap<FleetPage<RunnerSummaryDto>>(await projectFleetRunnersControllerList({ path: { slug }, query: { size: 100 } })).records;
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

// The API's error envelope carries an AppException code, not the HTTP status (Global Constraints).
// Repo-wide fix tracked in #176; fold this back into handleApiError when it lands.
const RET_STATUS: ReadonlyMap<number, number> = new Map([[40000, 401], [40003, 403], [404, 404], [-2, 400]]);

/**
 * handleApiError for fleet commands: maps the envelope code to the status handleApiError reads, so 401/403
 * exit 2, 404 exits 4 (with `notFoundMessage`) and validation exits 3. `adminHint` adds the admin-token hint to a 403.
 */
export function handleFleetError(err: unknown, opts: { notFoundMessage?: string; adminHint?: boolean } = {}): never {
  const code = apiErrorCode(err);
  const status = code === undefined ? undefined : RET_STATUS.get(code);
  if (status === 403 && opts.adminHint) error(ADMIN_TOKEN_HINT);
  const mapped = status === undefined ? err : { ...(err as Record<string, unknown>), status };
  return handleApiError(mapped, opts.notFoundMessage ? { notFoundMessage: opts.notFoundMessage } : undefined);
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
