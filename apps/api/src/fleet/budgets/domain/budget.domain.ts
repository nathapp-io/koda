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

export const BUDGET_REPOSITORY = Symbol('BUDGET_REPOSITORY');

export interface NewBudgetPolicy {
  scopeType: BudgetScopeType;
  scopeId: string | null;
  scopeKey: string;
  projectId: string | null;
  windowKind: BudgetWindowKind;
  amountUsd: string;
  warnPercent: number | null;
  hardStop: boolean;
  runningJobs: BudgetRunningJobs;
  createdById: string;
}

export type BudgetPolicyPatch = Partial<Pick<BudgetPolicyRecord,
  'amountUsd' | 'warnPercent' | 'hardStop' | 'runningJobs' | 'pausedAt' | 'pausedWindowStart' | 'updatedById'>>;

export interface NewBudgetIncident {
  policyId: string;
  kind: BudgetIncidentKind;
  windowStart: Date;
  spentUsd: string;
  amountUsd: string;
  actorId: string | null;
  /** S1.5: the approval this incident raised or resolved; omitted = null. */
  approvalId?: string | null;
}

/** create() hit the (scopeKey, windowKind) unique index. */
export class DuplicateBudgetPolicyError extends Error {
  constructor() {
    super('a budget policy already exists for this scope and window');
  }
}

export interface IBudgetRepository {
  findById(id: string): Promise<BudgetPolicyRecord | null>;
  /** SELECT ... FOR UPDATE (inside txManager.run); null when the policy is gone. */
  lockById(id: string): Promise<BudgetPolicyRecord | null>;
  /** Every policy, by scopeKey then windowKind. */
  findAll(): Promise<BudgetPolicyRecord[]>;
  findByScopeKeys(keys: readonly string[]): Promise<BudgetPolicyRecord[]>;
  /** S1b §2.4 member list: the global policies plus the project's project and repo policies. */
  findVisibleToProject(projectId: string): Promise<BudgetPolicyRecord[]>;
  /** Policies with pausedAt set, effective or stale; filter with isEffectivelyPaused. */
  findPaused(): Promise<BudgetPolicyRecord[]>;
  /** @throws DuplicateBudgetPolicyError */
  create(data: NewBudgetPolicy): Promise<BudgetPolicyRecord>;
  update(id: string, patch: BudgetPolicyPatch): Promise<BudgetPolicyRecord>;
  /** Incidents go with it (FK cascade). */
  delete(id: string): Promise<void>;
  /** Plan D166: global always; a project that is not soft-deleted; an existing repo or runner row. */
  scopeExists(scope: BudgetScope): Promise<boolean>;
  /** The fleet repo's project id, or null when there is no such repo (repo-scope create, S1b §2.4). */
  findRepoProjectId(repoId: string): Promise<string | null>;
  /** S1b §2.1 window spend as a decimal string; `since` null = lifetime. */
  windowSpend(scope: BudgetScope, since: Date | null): Promise<string>;
  /** INSERT ... ON CONFLICT DO NOTHING (a unique violation would abort the transaction); true when inserted. */
  insertIncident(incident: NewBudgetIncident): Promise<boolean>;
  /** QUEUED jobs in scope, oldest first; a runner scope means jobs pinned to it (S1b §2.2). */
  findQueuedJobIds(scope: BudgetScope): Promise<string[]>;
  /** ASSIGNED and RUNNING jobs in scope, oldest first; a runner scope means jobs it holds. */
  findHeldJobIds(scope: BudgetScope): Promise<string[]>;
}
