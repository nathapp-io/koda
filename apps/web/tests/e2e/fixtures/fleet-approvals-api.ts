/**
 * The API calls the approval E2E journeys make outside the browser. Responses use the { ret, data } envelope.
 *
 * P3b US-007 moved every web surface these journeys drive onto the approval engine, and US-010 removed the fleet
 * inbox: the calls here read `GET /approvals` (the engine list, filtered by `projectId` / `permissionKey` / `jobId`)
 * and `GET /approvals/<id>` (its detail), never the fleet approval view 7c retires. The engine's list row is
 * `ApprovalRequestSummaryDto`, so the fields the fleet summary used to carry (a budget `policyId`, a bash `jobId`)
 * now come from the detail's `details`.
 */
import { randomBytes } from 'node:crypto';
import { call } from './fleet-budgets-api';

/** `ApprovalRequestSummaryDto`: what `GET /approvals` lists. */
export interface ApprovalRow {
  id: string;
  permissionKey: string;
  status: string;
  projectId: string | null;
}

/** `ApprovalRequestDto`: the summary plus the command's own `details`, `input`, `result` and `decisions`. */
export interface ApprovalDetailRow extends ApprovalRow {
  details: Record<string, unknown> | null;
  input: unknown;
  result: unknown;
}

/** The permission key a budget hard stop raises (`apps/api` `FleetBudgetOverrideCommand`). */
export const BUDGET_APPROVAL_KEY = 'fleet.budget.override';

export async function createProjectPolicy(token: string, slug: string, amountUsd: number): Promise<string> {
  const created = await call<{ id: string }>('POST', `/projects/${slug}/fleet/budgets`, token, {
    scopeType: 'project', windowKind: 'calendar_month_utc', amountUsd, warnPercent: null, hardStop: true, runningJobs: 'finish',
  });
  return created.id;
}

/** The project's id, which is what `GET /approvals?projectId=` filters on (the engine knows ids, not slugs). */
export async function projectIdOf(token: string, slug: string): Promise<string> {
  const project = await call<{ id: string }>('GET', `/projects/${slug}`, token);
  return project.id;
}

/** One request in full: the fleet-only fields (`jobId`, `policyId`) live on `details`, not on the list row. */
export const approvalDetail = (token: string, id: string): Promise<ApprovalDetailRow> =>
  call<ApprovalDetailRow>('GET', `/approvals/${id}`, token);

/** The pending budget hard stops of one project, read through the engine's list. */
export async function pendingBudgetApprovals(token: string, projectId: string): Promise<ApprovalRow[]> {
  const page = await call<{ records: ApprovalRow[] }>(
    'GET', `/approvals?status=pending&permissionKey=${BUDGET_APPROVAL_KEY}&projectId=${projectId}&size=100`, token,
  );
  return page.records;
}

export async function jobState(token: string, slug: string, jobId: string): Promise<string> {
  const job = await call<{ state: string }>('GET', `/projects/${slug}/fleet/jobs/${jobId}`, token);
  return job.state;
}

/** The relayed ask fields (2a ApprovalRequestEventPayload) the E2E specs send. */
export type BashAskFields = {
  naxAskId: string;
  deadlineAt: string;
  command: string;
  commandTruncated: boolean;
  maskedCount: number;
  root: string;
  stage: string;
  storyId: string;
  featureName: string;
  reason: string;
  options: string[];
};

/** A real-shaped relayed ask; `deadlineAt` 10 minutes out unless overridden. A misspelled override key is a type error. */
export function bashAsk(over: Partial<BashAskFields> = {}): BashAskFields {
  return {
    naxAskId: `ask-${randomBytes(4).toString('hex')}`,
    deadlineAt: new Date(Date.now() + 10 * 60_000).toISOString(),
    command: 'git push --force origin HEAD',
    commandTruncated: false,
    maskedCount: 1,
    root: '/work/e2e-app',
    stage: 'execution',
    storyId: 'US-001',
    featureName: 'bash-e2e',
    reason: 'not covered by the stage grants',
    options: ['allow', 'allow-remember', 'deny'],
    ...over,
  };
}

/** Every approval of one job, through the engine's `jobId` filter (it joins the fleet ask). */
export async function jobApprovals(token: string, jobId: string): Promise<ApprovalRow[]> {
  const page = await call<{ records: ApprovalRow[] }>('GET', `/approvals?jobId=${jobId}&size=100`, token);
  return page.records;
}
