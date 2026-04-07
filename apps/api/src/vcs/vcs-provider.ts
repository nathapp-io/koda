import { VcsIssue, VcsPullRequest, VcsPrStatus, CreatePrParams } from './types';

/**
 * Interface for VCS providers (GitHub, GitLab, etc.)
 */
export interface IVcsProvider {
  /**
   * Fetch issues from the repository
   * @param since Optional - fetch issues created after this date
   */
  fetchIssues(since?: Date): Promise<VcsIssue[]>;

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
}
