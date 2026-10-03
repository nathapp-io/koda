/**
 * Fleet S1b slice 2b: the API calls the budgets e2e makes outside the browser (dispatching a job for the
 * scripted runner, reading policy state, cleaning up). Responses use the { ret, data } envelope.
 */
const API_URL = process.env['E2E_API_URL'] ?? 'http://localhost:3102';

export async function call<T>(method: string, path: string, token: string, body?: unknown): Promise<T> {
  const res = await fetch(`${API_URL}/api${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} failed: ${res.status} ${text}`);
  if (text === '') return undefined as T;
  const parsed = JSON.parse(text) as { ret?: number; data?: T };
  if (parsed.ret !== 0) throw new Error(`${method} ${path} answered ret ${String(parsed.ret)}: ${text}`);
  return parsed.data as T;
}

export interface PolicyRow {
  id: string;
  scopeType: string;
  paused: boolean;
  spentUsd: string;
  amountUsd: string;
}

/** The fleet repo id for `owner/name` in a project. */
export async function repoIdOf(token: string, slug: string, fullName: string): Promise<string> {
  const page = await call<{ records: Array<{ id: string; owner: string; name: string }> }>('GET', `/projects/${slug}/fleet/repos?size=100`, token);
  const repo = page.records.find((r) => `${r.owner}/${r.name}` === fullName);
  if (!repo) throw new Error(`No fleet repo ${fullName} in ${slug}`);
  return repo.id;
}

/** Dispatches a RUN pinned to one runner and returns the job id. */
export async function dispatchRun(
  token: string,
  slug: string,
  input: { repoId: string; feature: string; maxCostUsd: number; pinnedRunnerId: string; bashMode?: 'raw' | 'gated' | 'escalate'; approvalTimeoutSec?: number },
): Promise<string> {
  const result = await call<{ job: { id: string } }>('POST', `/projects/${slug}/fleet/jobs`, token, { command: 'RUN', ...input });
  return result.job.id;
}

export const listPolicies = (token: string, slug: string): Promise<PolicyRow[]> =>
  call<PolicyRow[]>('GET', `/projects/${slug}/fleet/budgets`, token);

/** Removes the project's own (project and repo) policies; global ones are not this spec's to touch. */
export async function deleteOwnPolicies(token: string, slug: string): Promise<void> {
  const rows = await listPolicies(token, slug);
  for (const row of rows.filter((r) => r.scopeType === 'project' || r.scopeType === 'repo')) {
    await call<void>('DELETE', `/projects/${slug}/fleet/budgets/${row.id}`, token);
  }
}

/**
 * The project's calendar-month fleet spend, read the same way the budget evaluator computes it: a
 * throwaway project policy with a limit no job can reach answers its own window spend (PolicyRow.spentUsd).
 * The probe is deleted before any runner sync, so it never gates a dispatch or pauses the project.
 * The whole fleet suite shares one calendar-month window per run, so policy-creating specs state
 * amounts as headroom above this value to stay correct in every file order.
 */
export async function monthSpendUsd(token: string, slug: string): Promise<number> {
  const created = await call<{ id: string }>('POST', `/projects/${slug}/fleet/budgets`, token, {
    scopeType: 'project', windowKind: 'calendar_month_utc', amountUsd: 1_000_000, warnPercent: null, hardStop: true, runningJobs: 'finish',
  });
  const probe = (await listPolicies(token, slug)).find((r) => r.id === created.id);
  if (!probe) throw new Error(`Probe policy ${created.id} not found in ${slug}`);
  await call<void>('DELETE', `/projects/${slug}/fleet/budgets/${created.id}`, token);
  return Number(probe.spentUsd);
}
