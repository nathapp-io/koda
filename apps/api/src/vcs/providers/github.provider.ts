import { NotFoundAppException, ValidationAppException } from '@nathapp/nestjs-common';
import { IVcsProvider } from '../vcs-provider';
import { VcsIssue, VcsPullRequest, VcsPrStatus, CreatePrParams } from '../types';
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
 * GitHub REST API response for a repository
 */
interface GitHubRepoResponse {
  default_branch: string;
}

/**
 * GitHub REST API response for ref creation
 */
interface GitHubRefResponse {
  ref: string;
  object: {
    sha: string;
  };
}

/**
 * GitHub REST API response for PR creation
 */
interface GitHubPullRequestResponse {
  number: number;
  html_url: string;
  state: string;
  draft: boolean;
}

/**
 * GitHub REST API response for a pull request (from GET /repos/{owner}/{repo}/pulls/{pr_number})
 */
interface GitHubPrStatusResponse {
  number: number;
  state: string;
  draft: boolean;
  merged: boolean;
  merged_at: string | null;
  merged_by: { login: string } | null;
  merge_commit_sha: string | null;
  html_url: string;
  title: string;
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

  async getDefaultBranch(): Promise<string> {
    const url = `https://api.github.com/repos/${this.repoOwner}/${this.repoName}`;

    const response = await this.httpClient.get(url, {
      headers: {
        Authorization: `Bearer ${this.token}`,
      },
    });

    const data = response.data as { default_branch: string };
    return data.default_branch;
  }

  async createPullRequest(params: CreatePrParams): Promise<VcsPullRequest> {
    const repoResponse = await this.httpClient.get(
      `https://api.github.com/repos/${this.repoOwner}/${this.repoName}`,
      {
        headers: {
          Authorization: `Bearer ${this.token}`,
        },
      },
    );

    const repoData = repoResponse.data as GitHubRepoResponse;
    const defaultBranch = repoData.default_branch;

    let branchSha: string;
    try {
      const refResponse = await this.httpClient.post(
        `https://api.github.com/repos/${this.repoOwner}/${this.repoName}/git/refs`,
        {
          headers: {
            Authorization: `Bearer ${this.token}`,
          },
          body: {
            ref: `refs/heads/${params.headBranch}`,
            sha: defaultBranch,
          },
        },
      );
      const refData = refResponse.data as GitHubRefResponse;
      branchSha = refData.object.sha;
    } catch (error: unknown) {
      const errorObj = error as Record<string, unknown>;
      const status = (errorObj?.response as Record<string, unknown>)?.status;
      if (status === 422) {
        // Branch already exists, proceed to PR creation
      } else {
        throw error;
      }
    }

    const prResponse = await this.httpClient.post(
      `https://api.github.com/repos/${this.repoOwner}/${this.repoName}/pulls`,
      {
        headers: {
          Authorization: `Bearer ${this.token}`,
        },
        body: {
          title: params.title,
          body: params.body,
          head: params.headBranch,
          base: defaultBranch,
          draft: true,
        },
      },
    );

    const prData = prResponse.data as GitHubPullRequestResponse;

    return {
      number: prData.number,
      url: prData.html_url,
      branchName: params.headBranch,
      state: prData.state,
      draft: prData.draft,
    };
  }

  async getPullRequestStatus(prNumber: number): Promise<VcsPrStatus> {
    const url = `https://api.github.com/repos/${this.repoOwner}/${this.repoName}/pulls/${prNumber}`;

    try {
      const response = await this.httpClient.get(url, {
        headers: {
          Authorization: `Bearer ${this.token}`,
        },
      });

      return this.mapGitHubPrToVcsPrStatus(response.data as GitHubPrStatusResponse);
    } catch (error: unknown) {
      const errorObj = error as Record<string, unknown>;
      if ((errorObj?.response as Record<string, unknown>)?.status === 404) {
        throw new NotFoundAppException(`PR #${prNumber} not found`);
      }
      throw error;
    }
  }

  async listPullRequests(state: 'open' | 'closed' | 'all' = 'open'): Promise<VcsPrStatus[]> {
    const url = `https://api.github.com/repos/${this.repoOwner}/${this.repoName}/pulls`;

    const response = await this.httpClient.get(url, {
      headers: {
        Authorization: `Bearer ${this.token}`,
      },
      params: {
        state,
      },
    });

    const data = response.data as GitHubPrStatusResponse[];
    return data.map((pr) => this.mapGitHubPrToVcsPrStatus(pr));
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

  private mapGitHubPrToVcsPrStatus(gitHubPr: GitHubPrStatusResponse): VcsPrStatus {
    return {
      number: gitHubPr.number,
      state: gitHubPr.state,
      draft: gitHubPr.draft,
      merged: gitHubPr.merged,
      mergedAt: gitHubPr.merged_at ? new Date(gitHubPr.merged_at) : null,
      mergedBy: gitHubPr.merged_by?.login ?? null,
      mergeSha: gitHubPr.merge_commit_sha,
      url: gitHubPr.html_url,
      title: gitHubPr.title,
    };
  }
}
