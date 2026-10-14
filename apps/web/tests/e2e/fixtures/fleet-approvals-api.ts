/**
 * Fleet S1.5 slice 1b: the API calls the approvals e2e makes outside the browser. Responses use the { ret, data } envelope.
 */
import { randomBytes } from 'node:crypto';
import { call } from './fleet-budgets-api';

export interface ApprovalRow {
  id: string;
  type: string;
  status: string;
  policyId: string | null;
}

export interface BashApprovalRow extends ApprovalRow {
  jobId: string | null;
  expiresAt: string | null;
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

/** Every approval of one job (2a `jobId` filter). */
export async function jobApprovals(token: string, slug: string, jobId: string): Promise<BashApprovalRow[]> {
  const page = await call<{ records: BashApprovalRow[] }>('GET', `/projects/${slug}/fleet/approvals?jobId=${jobId}&size=100`, token);
  return page.records;
}
