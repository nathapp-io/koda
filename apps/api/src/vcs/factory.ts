import { ValidationAppException } from '@nathapp/nestjs-common';
import { IVcsProvider } from './vcs-provider';
import { GitHubProvider } from './providers/github.provider';
import { GitLabProvider } from './providers/gitlab.provider';

/**
 * HTTP client interface for making requests
 */
export interface HttpClient {
  get(url: string, config: { headers: Record<string, string>; params?: Record<string, unknown> }): Promise<{ data: unknown }>;
  post(url: string, config: { headers: Record<string, string>; body: unknown }): Promise<{ data: unknown }>;
}

/**
 * Configuration for creating a VCS provider
 */
export interface VcsProviderConfig {
  provider: string;
  token: string;
  repoUrl: string;
  /** GitHub API base URL (GHES support); defaults to https://api.github.com */
  githubApiUrl?: string;
  /** GitLab API base URL (self-hosted support); defaults to https://gitlab.com/api/v4 */
  gitlabApiUrl?: string;
  [key: string]: unknown;
  httpClient?: HttpClient;
}

/**
 * An HTTP error that keeps the status and the parsed JSON body (GitLab reports conflicts in the body).
 */
async function httpError(response: Response): Promise<Error> {
  const data: unknown = await response.json().catch(() => undefined);
  const error = new Error(`HTTP ${response.status}`);
  (error as unknown as Record<string, unknown>).response = { status: response.status, data };
  return error;
}

/**
 * Create a default HTTP client using native fetch API
 */
function createDefaultHttpClient(): HttpClient {
  return {
    async get(url: string, config: { headers: Record<string, string>; params?: Record<string, unknown> }): Promise<{ data: unknown }> {
      const urlObj = new URL(url);
      if (config.params) {
        Object.entries(config.params).forEach(([key, value]) => {
          urlObj.searchParams.append(key, String(value));
        });
      }

      const response = await fetch(urlObj.toString(), {
        method: 'GET',
        headers: config.headers,
      });

      if (!response.ok) {
        throw await httpError(response);
      }

      const data = await response.json();
      return { data };
    },
    async post(url: string, config: { headers: Record<string, string>; body: unknown }): Promise<{ data: unknown }> {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...config.headers,
        },
        body: JSON.stringify(config.body),
      });

      if (!response.ok) {
        throw await httpError(response);
      }

      const data = await response.json();
      return { data };
    },
  };
}

/**
 * Owner and name from a repository web URL on any host (GHES, self-hosted
 * GitLab). GitHub takes the first two path segments. GitLab takes every segment
 * before the last as the (sub)group path, stopping at a `/-/` route.
 */
export function parseRepoPath(
  providerType: string,
  repoUrl: string | undefined,
): { repoOwner: string; repoName: string } | null {
  if (!repoUrl) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(repoUrl) ? repoUrl : `https://${repoUrl}`;
  let segments: string[];
  try {
    segments = new URL(withScheme).pathname.split('/').filter(Boolean);
  } catch {
    return null;
  }

  if (providerType.toLowerCase() === 'gitlab') {
    const routeStart = segments.indexOf('-');
    const path = routeStart === -1 ? segments : segments.slice(0, routeStart);
    if (path.length < 2) return null;
    return { repoOwner: path.slice(0, -1).join('/'), repoName: path[path.length - 1].replace(/\.git$/, '') };
  }

  if (segments.length < 2) return null;
  return { repoOwner: segments[0], repoName: segments[1].replace(/\.git$/, '') };
}

/**
 * Factory function to create VCS provider instances
 */
export function createVcsProvider(
  providerType: string | null | undefined,
  config: VcsProviderConfig,
): IVcsProvider {
  if (!providerType || typeof providerType !== 'string') {
    throw new ValidationAppException({}, 'vcs');
  }

  const type = providerType.toLowerCase();
  if (type !== 'github' && type !== 'gitlab') {
    throw new ValidationAppException({}, 'vcs');
  }

  const repo = parseRepoPath(type, config.repoUrl);
  if (!repo) {
    throw new ValidationAppException({}, 'vcs');
  }

  const httpClient = config.httpClient ?? createDefaultHttpClient();
  return type === 'github'
    ? new GitHubProvider(repo.repoOwner, repo.repoName, config.token, httpClient, config.githubApiUrl)
    : new GitLabProvider(repo.repoOwner, repo.repoName, config.token, httpClient, config.gitlabApiUrl);
}
