/**
 * Fleet S1.5 slice 1b: the API calls the approvals e2e makes outside the browser. Responses use the { ret, data } envelope.
 */
import { call } from './fleet-budgets-api';

export interface ApprovalRow {
  id: string;
  type: string;
  status: string;
  policyId: string | null;
}

export async function createProjectPolicy(token: string, slug: string, amountUsd: number): Promise<string> {
  const created = await call<{ id: string }>('POST', `/projects/${slug}/fleet/budgets`, token, {
    scopeType: 'project', windowKind: 'calendar_month_utc', amountUsd, warnPercent: null, hardStop: true, runningJobs: 'finish',
  });
  return created.id;
}

export async function pendingBudgetApprovals(token: string, slug: string): Promise<ApprovalRow[]> {
  const page = await call<{ records: ApprovalRow[] }>(
    'GET', `/projects/${slug}/fleet/approvals?status=pending&type=budget_override_required&size=100`, token,
  );
  return page.records;
}

export async function jobState(token: string, slug: string, jobId: string): Promise<string> {
  const job = await call<{ state: string }>('GET', `/projects/${slug}/fleet/jobs/${jobId}`, token);
  return job.state;
}
