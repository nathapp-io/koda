import type { IPageOption } from '@nathapp/nestjs-common';
import type { IPageResult } from '@nathapp/nestjs-data';
import type { RuleOverrideInput } from '../rule-override';

export const FLEET_REPO_REPOSITORY = Symbol('FLEET_REPO_REPOSITORY');

/**
 * The rule-override facts a repo listing carries: the hash, the file count and the modes, but never
 * the rule bodies. Read from the row's scalar columns, so listing repos does not load rule files.
 */
export interface RuleOverrideSummary {
  sha256: string;
  ruleFiles: number;
  rulesMode: 'merge' | 'replace';
  contextMode: 'append' | 'replace' | null;
  updatedAt: Date;
}

/** The stored override of one repo: its rule files, its optional context and its hash. */
export interface FleetRepoRuleOverrideRecord {
  repoId: string;
  rules: { path: string; content: string }[];
  rulesMode: 'merge' | 'replace';
  context: { content: string; mode: 'append' | 'replace' } | null;
  sha256: string;
  ruleFiles: number;
  updatedAt: Date;
}

/** Who wrote an override: the principal the write is attributed to. */
export interface RuleOverrideActor {
  id: string;
  type: 'USER' | 'AGENT';
}

export interface FleetRepoRecord {
  id: string;
  projectId: string;
  provider: string;
  owner: string;
  name: string;
  defaultBranch: string;
  githubInstallationId: bigint | null;
  createdById: string;
  createdAt: Date;
  autoReview: boolean;
  autoReviewProfiles: string[];
  autoReviewMaxCostUsd: string;
  autoReviewEnabledById: string | null;
  autoReviewEnabledByType: 'USER' | 'AGENT' | null;
  autoReviewEnabledAt: Date | null;
  /**
   * Fleet FIX (fix detected checks): allow `nax bot fix` to run the checks it detects for a base
   * branch with no nax check commands. Optional so a fixture written before the column stays valid;
   * absent means `false` (the migration default).
   */
  fixTrustDetectedChecks?: boolean;
  /**
   * FIX override: a FIX may mint write credentials although the default branch is unprotected. Optional so
   * older fixtures stay valid; absent means `false` (the migration default).
   */
  fixAllowUnprotected?: boolean;
  /**
   * The repo's rule override summary (#370), when it has one. Optional so a fixture written before
   * the relation stays valid; absent means none.
   */
  ruleOverride?: RuleOverrideSummary | null;
}

export type AutoReviewPatch = Partial<Pick<FleetRepoRecord,
  'autoReview' | 'autoReviewProfiles' | 'autoReviewMaxCostUsd' | 'autoReviewEnabledById' | 'autoReviewEnabledByType' | 'autoReviewEnabledAt'
>>;

export interface IFleetRepoRepository {
  findProject(slug: string): Promise<{ id: string; slug: string } | null>;
  /** Throws ConflictAppException(fleet.repos) on a duplicate (provider, owner, name). */
  create(data: Omit<FleetRepoRecord, 'id' | 'createdAt' | 'autoReview' | 'autoReviewProfiles' | 'autoReviewMaxCostUsd' | 'autoReviewEnabledById' | 'autoReviewEnabledByType' | 'autoReviewEnabledAt' | 'fixTrustDetectedChecks' | 'fixAllowUnprotected' | 'ruleOverride'>): Promise<FleetRepoRecord>;
  findById(id: string): Promise<FleetRepoRecord | null>;
  /**
   * The nax flow entry resolves a remote URL to its repo: the owner and name compare
   * case-insensitively, because a forge's URLs and a registered row do not agree on case.
   */
  findByIdentity(provider: string, owner: string, name: string): Promise<FleetRepoRecord | null>;
  /**
   * SELECT ... FOR UPDATE on the repo row, returning the locked record. The nax flow entry
   * serialises creation on it, so two concurrent calls cannot both pass the duplicate check.
   */
  lockById(id: string): Promise<FleetRepoRecord | null>;
  updateAutoReview(id: string, patch: AutoReviewPatch): Promise<FleetRepoRecord>;
  /** The fix-checks setting (fleet FIX US-001): one boolean column, answered as the updated record. */
  updateFixChecks(id: string, value: boolean): Promise<FleetRepoRecord>;
  /** The FIX unprotected-branch override: one boolean column, answered as the updated record. */
  updateFixUnprotected(id: string, value: boolean): Promise<FleetRepoRecord>;
  /**
   * The project's anchor repo (fleet S5b-R13): the smallest `createdAt`, ties broken by the smallest `id`; null when
   * the project has no fleet repo. A PROJECT thread uses it as bookkeeping only — no checkout, no git token.
   */
  findAnchor(projectId: string): Promise<FleetRepoRecord | null>;
  findPage(filters: { projectId?: string }, page: IPageOption): Promise<IPageResult<FleetRepoRecord>>;
  findAutoReviewPage(limit: number): Promise<FleetRepoRecord[]>;
  /**
   * The compare-and-set turn-off (auto-review spec, call 4): clears the flag and its three attribution
   * columns only while `autoReviewEnabledById` is still `expectedEnablerId`, keeping profiles and cost.
   * False when the row was already off or someone else re-enabled it, so a stale pass turns nothing off.
   */
  disableAutoReviewIf(id: string, expectedEnablerId: string): Promise<boolean>;
  delete(id: string): Promise<void>;
  /** Number of the repo's jobs in an active state (plan D15). */
  countUnfinishedJobs(repoId: string): Promise<number>;
  /** SELECT ... FOR UPDATE on the repo row, so the delete decision sees a stable row (review m6). */
  lockForDelete(id: string): Promise<void>;
  /**
   * The repo's stored rule override (#370), with its rule bodies; null when it has none.
   */
  findRuleOverride(repoId: string): Promise<FleetRepoRuleOverrideRecord | null>;
  /**
   * Stores the repo's rule override, replacing an earlier one. The input is the validated one and
   * the hash is the one computed over it, so the stored row and its summary agree.
   */
  upsertRuleOverride(
    repoId: string,
    input: RuleOverrideInput,
    sha256: string,
    actor: RuleOverrideActor,
  ): Promise<FleetRepoRuleOverrideRecord>;
  /**
   * Removes the repo's rule override; false when there was none, so the caller audits only a real
   * removal.
   */
  deleteRuleOverride(repoId: string): Promise<boolean>;
}
