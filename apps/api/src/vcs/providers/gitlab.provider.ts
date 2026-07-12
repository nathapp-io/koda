import { NotFoundAppException, ValidationAppException } from '@nathapp/nestjs-common';
import { IVcsProvider } from '../vcs-provider';
import { VcsIssue, VcsPullRequest, VcsPrStatus, VcsCommit, CreatePrParams, SourceFile } from '../types';
import { HttpClient } from '../factory';

/**
 * GitLab REST API (v4) response for an issue
 */
interface GitLabIssueResponse {
  iid: number;
  title: string;
  description: string | null;
  author: {
    username: string;
  };
  web_url: string;
  labels: string[];
  created_at: string;
}

/**
 * GitLab REST API response for a project
 */
interface GitLabProjectResponse {
  default_branch: string;
}

/**
 * GitLab REST API response for a merge request
 */
interface GitLabMergeRequestResponse {
  iid: number;
  web_url: string;
  state: string;
  draft: boolean;
  source_branch: string;
}

/**
 * GitLab REST API response for a merge request status (from GET /projects/:id/merge_requests/:iid)
 */
interface GitLabMrStatusResponse {
  iid: number;
  state: string;
  draft: boolean;
  merged_at: string | null;
  merged_by: { username: string } | null;
  merge_commit_sha: string | null;
  web_url: string;
  title: string;
  source_branch: string;
}

/**
 * GitLab REST API response for a commit (from GET /projects/:id/merge_requests/:iid/commits)
 */
interface GitLabCommitResponse {
  id: string;
  message: string;
  author_name: string;
  author_email: string;
  authored_date: string;
}

/**
 * GitLab REST API response for a repository file (from GET /projects/:id/repository/files/:file_path)
 */
interface GitLabFileResponse {
  content?: string;
  encoding?: string;
}

/**
 * GitLab VCS provider implementation (targets gitlab.com API v4)
 */
export class GitLabProvider implements IVcsProvider {
  private readonly projectId: string;

  constructor(
    private readonly repoOwner: string,
    private readonly repoName: string,
    private readonly token: string,
    private readonly httpClient: HttpClient,
  ) {
    this.projectId = encodeURIComponent(`${repoOwner}/${repoName}`);
  }

  private get baseUrl(): string {
    return `https://gitlab.com/api/v4/projects/${this.projectId}`;
  }

  private get authHeaders(): Record<string, string> {
    return { 'PRIVATE-TOKEN': this.token };
  }

  async fetchIssues(since?: Date): Promise<VcsIssue[]> {
    const params: Record<string, unknown> = {
      state: 'opened',
      order_by: 'created_at',
      sort: 'asc',
    };

    if (since) {
      params.created_after = since.toISOString();
    }

    const response = await this.httpClient.get(`${this.baseUrl}/issues`, {
      headers: this.authHeaders,
      params,
    });

    const data = response.data as GitLabIssueResponse[];
    return data.map((issue) => this.mapGitLabIssueToVcsIssue(issue));
  }

  async fetchIssue(issueNumber: number): Promise<VcsIssue> {
    try {
      const response = await this.httpClient.get(`${this.baseUrl}/issues/${issueNumber}`, {
        headers: this.authHeaders,
      });

      return this.mapGitLabIssueToVcsIssue(response.data as GitLabIssueResponse);
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
      await this.httpClient.get(this.baseUrl, {
        headers: this.authHeaders,
      });

      return { ok: true };
    } catch (error: unknown) {
      const errorMessage = (error as Record<string, unknown>)?.message || 'Connection failed';
      return { ok: false, error: errorMessage as string };
    }
  }

  async getDefaultBranch(): Promise<string> {
    const response = await this.httpClient.get(this.baseUrl, {
      headers: this.authHeaders,
    });

    const data = response.data as GitLabProjectResponse;
    return data.default_branch;
  }

  async createPullRequest(params: CreatePrParams): Promise<VcsPullRequest> {
    const branchName = params.branchName ?? params.headBranch;
    if (!branchName) {
      throw new ValidationAppException({}, 'vcs');
    }

    const projectResponse = await this.httpClient.get(this.baseUrl, {
      headers: this.authHeaders,
    });

    const projectData = projectResponse.data as GitLabProjectResponse;
    const defaultBranch = projectData.default_branch;
    const baseBranch = params.baseBranch ?? defaultBranch;

    try {
      await this.httpClient.post(`${this.baseUrl}/repository/branches`, {
        headers: this.authHeaders,
        body: {
          branch: branchName,
          ref: defaultBranch,
        },
      });
    } catch (error: unknown) {
      const errorObj = error as Record<string, unknown>;
      const status = (errorObj?.response as Record<string, unknown>)?.status;
      if (status === 400) {
        // Branch already exists, proceed to MR creation
      } else {
        throw error;
      }
    }

    const draft = params.draft ?? true;
    const title = draft ? `Draft: ${params.title}` : params.title;

    const mrResponse = await this.httpClient.post(`${this.baseUrl}/merge_requests`, {
      headers: this.authHeaders,
      body: {
        source_branch: branchName,
        target_branch: baseBranch,
        title,
        description: params.body,
      },
    });

    const mrData = mrResponse.data as GitLabMergeRequestResponse;

    return {
      number: mrData.iid,
      url: mrData.web_url,
      branchName,
      state: mrData.state,
      draft: mrData.draft ?? draft,
    };
  }

  async getPullRequestStatus(prNumber: number): Promise<VcsPrStatus> {
    try {
      const response = await this.httpClient.get(`${this.baseUrl}/merge_requests/${prNumber}`, {
        headers: this.authHeaders,
      });

      return this.mapGitLabMrToVcsPrStatus(response.data as GitLabMrStatusResponse);
    } catch (error: unknown) {
      const errorObj = error as Record<string, unknown>;
      if ((errorObj?.response as Record<string, unknown>)?.status === 404) {
        throw new NotFoundAppException(`PR #${prNumber} not found`);
      }
      throw error;
    }
  }

  async listPullRequests(state: 'open' | 'closed' | 'all' = 'open'): Promise<VcsPrStatus[]> {
    const stateParam = state === 'open' ? 'opened' : state;

    const response = await this.httpClient.get(`${this.baseUrl}/merge_requests`, {
      headers: this.authHeaders,
      params: {
        state: stateParam,
      },
    });

    const data = response.data as GitLabMrStatusResponse[];
    return data.map((mr) => this.mapGitLabMrToVcsPrStatus(mr));
  }

  async listPrCommits(prNumber: number): Promise<VcsCommit[]> {
    try {
      const response = await this.httpClient.get(`${this.baseUrl}/merge_requests/${prNumber}/commits`, {
        headers: this.authHeaders,
      });

      const data = response.data as GitLabCommitResponse[];
      return data.map((commit) => this.mapGitLabCommitToVcsCommit(commit));
    } catch (error: unknown) {
      const errorObj = error as Record<string, unknown>;
      if ((errorObj?.response as Record<string, unknown>)?.status === 404) {
        throw new NotFoundAppException(`PR #${prNumber} not found`);
      }
      throw error;
    }
  }

  private mapGitLabIssueToVcsIssue(gitLabIssue: GitLabIssueResponse): VcsIssue {
    return {
      number: gitLabIssue.iid,
      title: gitLabIssue.title,
      body: gitLabIssue.description,
      authorLogin: gitLabIssue.author.username,
      url: gitLabIssue.web_url,
      labels: gitLabIssue.labels,
      createdAt: new Date(gitLabIssue.created_at),
    };
  }

  private mapGitLabMrToVcsPrStatus(gitLabMr: GitLabMrStatusResponse): VcsPrStatus {
    return {
      number: gitLabMr.iid,
      state: gitLabMr.state === 'opened' ? 'open' : gitLabMr.state,
      draft: gitLabMr.draft,
      merged: gitLabMr.state === 'merged',
      mergedAt: gitLabMr.merged_at ? new Date(gitLabMr.merged_at) : null,
      mergedBy: gitLabMr.merged_by?.username ?? null,
      mergeSha: gitLabMr.merge_commit_sha,
      url: gitLabMr.web_url,
      title: gitLabMr.title,
      branchName: gitLabMr.source_branch,
    };
  }

  private mapGitLabCommitToVcsCommit(gitLabCommit: GitLabCommitResponse): VcsCommit {
    return {
      sha: gitLabCommit.id,
      message: gitLabCommit.message,
      authorLogin: gitLabCommit.author_name,
      url: `https://gitlab.com/${this.repoOwner}/${this.repoName}/-/commit/${gitLabCommit.id}`,
      date: new Date(gitLabCommit.authored_date),
    };
  }

  /**
   * Fetch file contents for files changed in a commit.
   * Uses GitLab's repository files API with the commit SHA as ref.
   */
  async fetchCommitFiles(repoId: string, commitHash: string, changedFiles: string[]): Promise<SourceFile[]> {
    const files: SourceFile[] = [];

    for (const filePath of changedFiles) {
      try {
        const encodedPath = encodeURIComponent(filePath);
        const url = `${this.baseUrl}/repository/files/${encodedPath}?ref=${commitHash}`;
        const response = await this.httpClient.get(url, {
          headers: this.authHeaders,
        });

        const data = response.data as GitLabFileResponse;
        if (data.content && data.encoding === 'base64') {
          const content = Buffer.from(data.content.replace(/\n/g, ''), 'base64').toString('utf-8');
          files.push({ path: filePath, content });
        }
      } catch (error: unknown) {
        const errorObj = error as Record<string, unknown>;
        const status = (errorObj?.response as Record<string, unknown>)?.status;
        if (status !== 404) {
          throw error;
        }
      }
    }

    return files;
  }
}
