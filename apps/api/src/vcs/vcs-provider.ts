import { VcsIssue } from './types';

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
}
