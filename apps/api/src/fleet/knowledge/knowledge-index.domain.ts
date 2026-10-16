/** Fleet S5b knowledge index (1c-c-D2/D3): domain types and the module-private repository contract. */

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
  fileCount: number;
  chunkCount: number;
  unembeddedCount: number;
  skippedCount: number;
  lastError: string | null;
  finishedAt: Date;
}

export interface KnowledgeProjectState {
  repo: KnowledgeRepoRef;
  state: KnowledgeIndexState | null;
}

export interface IKnowledgeIndexRepository {
  findRepo(repoId: string): Promise<KnowledgeRepoRef | null>;
  findProjectRepos(projectId: string): Promise<KnowledgeRepoRef[]>;
  findAllGithubRepos(): Promise<KnowledgeRepoRef[]>;
  /** Takes the repository's lease when it is free or expired; false when another pass holds it. */
  claim(repoId: string, projectId: string, now: Date, leaseMs: number): Promise<boolean>;
  /** Extends a held lease; false when the row is no longer running. */
  renew(repoId: string, leaseUntil: Date): Promise<boolean>;
  finish(repoId: string, result: KnowledgeFinishResult): Promise<void>;
  listFiles(repoId: string): Promise<KnowledgeFileState[]>;
  upsertFile(file: KnowledgeFileState): Promise<void>;
  deleteFile(repoId: string, path: string): Promise<void>;
  listStates(projectId: string): Promise<KnowledgeIndexState[]>;
}
