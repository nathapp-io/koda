import { NotFoundAppException, ValidationAppException } from '@nathapp/nestjs-common';
import { IVcsProvider } from '../vcs-provider';
import { VcsIssue } from '../types';

/**
 * GitHub REST API response for an issue
 */
interface GitHubIssueResponse {
  number: number;
  title: string;
  body: string | null;
  user: {
    login: string;
  };
  html_url: string;
  labels: Array<{ name: string }>;
  created_at: string;
  pull_request?: unknown;
}

/**
 * GitHub VCS provider implementation
 */
export class GitHubProvider implements IVcsProvider {
  constructor(
    private readonly repoOwner: string,
    private readonly repoName: string,
    private readonly token: string,
    private readonly httpClient: any, // HTTP client with get method
  ) {}

  async fetchIssues(since?: Date): Promise<VcsIssue[]> {
    const params: Record<string, any> = {
      state: 'open',
      sort: 'created',
      direction: 'asc',
    };

    if (since) {
      params.since = since.toISOString();
    }

    const url = `https://api.github.com/repos/${this.repoOwner}/${this.repoName}/issues`;

    const response = await this.httpClient.get(url, {
      headers: {
        Authorization: `Bearer ${this.token}`,
      },
      params,
    });

    // Filter out pull requests (which GitHub API returns in issues endpoint)
    const issues = response.data.filter((item: GitHubIssueResponse) => !item.pull_request);

    return issues.map(this.mapGitHubIssueToVcsIssue);
  }

  async fetchIssue(issueNumber: number): Promise<VcsIssue> {
    const url = `https://api.github.com/repos/${this.repoOwner}/${this.repoName}/issues/${issueNumber}`;

    try {
      const response = await this.httpClient.get(url, {
        headers: {
          Authorization: `Bearer ${this.token}`,
        },
      });

      return this.mapGitHubIssueToVcsIssue(response.data);
    } catch (error: any) {
      if (error?.response?.status === 404) {
        throw new NotFoundAppException(`Issue #${issueNumber} not found`);
      }
      throw error;
    }
  }

  async testConnection(): Promise<{ ok: boolean; error?: string }> {
    try {
      const url = `https://api.github.com/repos/${this.repoOwner}/${this.repoName}`;

      await this.httpClient.get(url, {
        headers: {
          Authorization: `Bearer ${this.token}`,
        },
      });

      return { ok: true };
    } catch (error: any) {
      const errorMessage = error?.message || 'Connection failed';
      return { ok: false, error: errorMessage };
    }
  }

  private mapGitHubIssueToVcsIssue(gitHubIssue: GitHubIssueResponse): VcsIssue {
    return {
      number: gitHubIssue.number,
      title: gitHubIssue.title,
      body: gitHubIssue.body,
      authorLogin: gitHubIssue.user.login,
      url: gitHubIssue.html_url,
      labels: gitHubIssue.labels.map((label) => label.name),
      createdAt: new Date(gitHubIssue.created_at),
    };
  }
}
