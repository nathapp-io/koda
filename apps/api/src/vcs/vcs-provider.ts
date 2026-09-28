import { VcsIssue, VcsPullRequest, VcsPrStatus, VcsCommit, CreatePrParams, SourceFile, IssueFetchResult } from './types';

/**
 * Interface for VCS providers (GitHub, GitLab, etc.)
 */
export interface IVcsProvider {
  /**
   * Fetch open issues in update order, paginated up to MAX_ISSUE_PAGES.
   * @param since Optional - only issues updated at or after this time
   */
  fetchIssues(since?: Date): Promise<IssueFetchResult>;

  /**
   * Fetch a specific issue by number
   */
  fetchIssue(issueNumber: number): Promise<VcsIssue>;

  /**
   * Test the connection to the VCS service
   */
  testConnection(): Promise<{ ok: boolean; error?: string }>;

  /**
   * Get the default branch name for the repository
   */
  getDefaultBranch(): Promise<string>;

  /**
   * Create a pull request
   * @param params The pull request parameters
   */
  createPullRequest(params: CreatePrParams): Promise<VcsPullRequest>;

  /**
   * Get a specific pull request status by number
   * @param prNumber The pull request number
   */
  getPullRequestStatus(prNumber: number): Promise<VcsPrStatus>;

  /**
   * List pull requests
   * @param state Optional filter - 'open', 'closed', or 'all' (defaults to 'open')
   */
  listPullRequests(state?: 'open' | 'closed' | 'all'): Promise<VcsPrStatus[]>;

  /**
   * List commits for a specific pull request
   * @param prNumber The pull request number
   */
  listPrCommits(prNumber: number): Promise<VcsCommit[]>;

  /**
   * Fetch the contents of files changed in a commit
   * @param repoId The repository identifier
   * @param commitHash The SHA of the commit
   * @param changedFiles List of file paths that were changed
   */
  fetchCommitFiles(repoId: string, commitHash: string, changedFiles: string[]): Promise<SourceFile[]>;
}
