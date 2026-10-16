/** Fleet S5b knowledge index (1c-c-D2/D3): domain types and the module-private repository contract. */

import type { RunOutcomeRow } from '../ingest/domain/bundle-ingest.domain';

export const KNOWLEDGE_INDEX_REPOSITORY = Symbol('KNOWLEDGE_INDEX_REPOSITORY');

export type KnowledgeIndexStatus = 'idle' | 'running' | 'failed' | 'skipped';

export interface KnowledgeRepoRef {
  id: string;
  projectId: string;
  provider: 'github' | 'gitlab';
  owner: string;
  name: string;
  defaultBranch: string;
  githubInstallationId: bigint | null;
}

export interface KnowledgeIndexState {
  repoId: string;
  projectId: string;
  status: KnowledgeIndexStatus;
  indexedSha: string | null;
  /** US-002: the patterns key the last finished pass selected with; null on a row written before the feature. */
  patternsKey?: string | null;
  fileCount: number;
  chunkCount: number;
  unembeddedCount: number;
  skippedCount: number;
  lastError: string | null;
  leaseUntil: Date | null;
  startedAt: Date | null;
  finishedAt: Date | null;
  updatedAt: Date;
}

export interface KnowledgeFileState {
  repoId: string;
  path: string;
  blobSha: string;
  chunkCount: number;
  unembeddedCount: number;
}

/** What a pass leaves behind. `indexedSha` undefined keeps the stored value (a failed pass never advances it). */
export interface KnowledgeFinishResult {
  projectId: string;
  status: Exclude<KnowledgeIndexStatus, 'running'>;
  indexedSha?: string | null;
  /** US-002: written when given, like `indexedSha`; a failed pass keeps the stored key. */
  patternsKey?: string | null;
  fileCount: number;
  chunkCount: number;
  unembeddedCount: number;
  skippedCount: number;
  lastError: string | null;
  finishedAt: Date;
  /** Finish always clears the lease. */
  leaseUntil?: null;
}

export interface KnowledgeProjectState {
  repo: KnowledgeRepoRef;
  state: KnowledgeIndexState | null;
}

/** S5b 3c-2-D4: the job whose outcomes a pass projects, with the repository it ran in. */
export interface KnowledgeRunOutcomeJob {
  id: string;
  projectId: string;
  repoId: string;
  owner: string;
  name: string;
  feature: string;
  resultSha: string | null;
}

/**
 * S5b 3c-2-D4: one job's latest ingested run outcomes, `report` first. `outcomes` is empty when that
 * epoch carried none, so a newer bundle without a report retires the older epoch's outcomes.
 */
export interface KnowledgeRunOutcomes {
  job: KnowledgeRunOutcomeJob;
  outcomes: RunOutcomeRow[];
}

export interface IKnowledgeIndexRepository {
  findRepo(repoId: string): Promise<KnowledgeRepoRef | null>;
  findProjectRepos(projectId: string): Promise<KnowledgeRepoRef[]>;
  findAllGithubRepos(): Promise<KnowledgeRepoRef[]>;
  /** Takes the repository's lease when it is free or expired; false when another pass holds it. */
  claim(repoId: string, projectId: string, now: Date, leaseMs: number): Promise<boolean>;
  /** Extends this pass's lease; startedAt fences a renewal against a later claim. */
  renew(repoId: string, leaseUntil: Date, startedAt?: Date): Promise<boolean>;
  finish(repoId: string, result: KnowledgeFinishResult): Promise<void>;
  listFiles(repoId: string): Promise<KnowledgeFileState[]>;
  upsertFile(file: KnowledgeFileState): Promise<void>;
  deleteFile(repoId: string, path: string): Promise<void>;
  listStates(projectId: string): Promise<KnowledgeIndexState[]>;
  /** US-002: the project's saved patterns, or null when it saved none. */
  findProjectPatterns(projectId: string): Promise<string[] | null>;
  /** US-002: null deletes the row (the project falls back to the default corpus). */
  saveProjectPatterns(projectId: string, patterns: string[] | null): Promise<void>;
  /**
   * S5b 3c-2-D4: the job's latest ingested run outcomes. The epoch is the highest `leaseEpoch` among the
   * job's `FleetBundleIngest` rows whose status is `done` or `partial`; null for an unknown job.
   */
  findRunOutcomes(jobId: string): Promise<KnowledgeRunOutcomes | null>;
}
