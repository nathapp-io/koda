/**
 * Represents a VCS issue from any provider (GitHub, GitLab, etc.)
 */
export interface VcsIssue {
  number: number;
  title: string;
  body: string | null;
  authorLogin: string;
  url: string;
  labels: string[];
  createdAt: Date;
}

/**
 * Parameters for creating a pull request
 */
export interface CreatePrParams {
  title: string;
  body: string;
  branchName?: string;
  headBranch?: string;
  baseBranch?: string;
  draft?: boolean;
}

/**
 * Represents a VCS pull request status from any provider
 */
export interface VcsPrStatus {
  number: number;
  state: string;
  draft: boolean;
  merged: boolean;
  mergedAt: Date | null;
  mergedBy: string | null;
  mergeSha: string | null;
  url: string;
  title: string;
  branchName?: string;
}

/**
 * Represents a VCS pull request from any provider
 */
export interface VcsPullRequest {
  number: number;
  url: string;
  branchName: string;
  state: string;
  draft: boolean;
}

/**
 * Represents a VCS commit from any provider
 */
export interface VcsCommit {
  sha: string;
  message: string;
  authorLogin: string;
  url: string;
  date: Date;
}
