export const BUDGET_SCOPE_TYPES = ['global', 'project', 'repo', 'runner'] as const;
export type BudgetScopeType = (typeof BUDGET_SCOPE_TYPES)[number];

export const BUDGET_WINDOW_KINDS = ['calendar_month_utc', 'lifetime'] as const;
export type BudgetWindowKind = (typeof BUDGET_WINDOW_KINDS)[number];

/** S1 ruling R2: what a hard stop does to ASSIGNED and RUNNING jobs. */
export const BUDGET_RUNNING_JOBS = ['finish', 'cancel'] as const;
export type BudgetRunningJobs = (typeof BUDGET_RUNNING_JOBS)[number];

export type BudgetIncidentKind = 'warn' | 'hard_stop' | 'resumed' | 'window_reset';

/** S1b §2.1. Money fields are decimal strings. */
export interface BudgetPolicyRecord {
  id: string;
  scopeType: BudgetScopeType;
  scopeId: string | null;
  scopeKey: string;
  projectId: string | null;
  windowKind: BudgetWindowKind;
  amountUsd: string;
  warnPercent: number | null;
  hardStop: boolean;
  runningJobs: BudgetRunningJobs;
  pausedAt: Date | null;
  pausedWindowStart: Date | null;
  createdById: string;
  updatedById: string;
  createdAt: Date;
  updatedAt: Date;
}

export type BudgetScope = Pick<BudgetPolicyRecord, 'scopeType' | 'scopeId'>;
