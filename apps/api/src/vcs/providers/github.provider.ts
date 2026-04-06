import { NotFoundAppException, ValidationAppException } from '@nathapp/nestjs-common';
import { IVcsProvider } from '../vcs-provider';
import { VcsIssue } from '../types';
import { HttpClient } from '../factory';

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
    private readonly httpClient: HttpClient,
  ) {}

  async fetchIssues(since?: Date): Promise<VcsIssue[]> {
    const params: Record<string, unknown> = {
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
    const data = response.data as GitHubIssueResponse[];
    const issues = data.filter((item) => !item.pull_request);

    return issues.map((issue) => this.mapGitHubIssueToVcsIssue(issue));
  }

  async fetchIssue(issueNumber: number): Promise<VcsIssue> {
    const url = `https://api.github.com/repos/${this.repoOwner}/${this.repoName}/issues/${issueNumber}`;

    try {
      const response = await this.httpClient.get(url, {
        headers: {
          Authorization: `Bearer ${this.token}`,
        },
      });

      return this.mapGitHubIssueToVcsIssue(response.data as GitHubIssueResponse);
    } catch (error: unknown) {
      const errorObj = error as Record<string, unknown>;
      if ((errorObj?.response as Record<string, unknown>)?.status === 404) {
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
    } catch (error: unknown) {
      const errorMessage = (error as Record<string, unknown>)?.message || 'Connection failed';
      return { ok: false, error: errorMessage as string };
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
