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
  headBranch: string;
  baseBranch: string;
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
