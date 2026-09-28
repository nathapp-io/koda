import { createVcsProvider, HttpClient } from './factory';
import type { IVcsProvider } from './vcs-provider';
import type { IVcsConfig } from '../config/vcs.config';

/** What a provider needs from a VCS connection. */
export interface VcsRepoTarget {
  provider: string;
  repoOwner: string;
  repoName: string;
}

export type VcsApiUrls = Partial<Pick<IVcsConfig, 'githubApiUrl' | 'gitlabApiUrl'>>;

const DEFAULT_GITHUB_API_URL = 'https://api.github.com';
const DEFAULT_GITLAB_API_URL = 'https://gitlab.com/api/v4';

const isGitLab = (target: VcsRepoTarget): boolean => target.provider.toLowerCase() === 'gitlab';
const trimSlashes = (url: string): string => url.replace(/\/+$/, '');

/**
 * The web host derived from the configured API base. Assumes the standard
 * suffixes: GitHub/GHES ends in `/api/v3` (or is api.github.com), GitLab ends in
 * `/api/v4`. A self-hosted instance behind a non-standard API path would need an
 * explicit web-URL override; the defaults and the documented suffixes are exact.
 */
function webBaseUrl(target: VcsRepoTarget, urls: VcsApiUrls): string {
  if (isGitLab(target)) {
    return trimSlashes(urls.gitlabApiUrl ?? DEFAULT_GITLAB_API_URL).replace(/\/api\/v4$/, '');
  }
  const api = trimSlashes(urls.githubApiUrl ?? DEFAULT_GITHUB_API_URL);
  return api === DEFAULT_GITHUB_API_URL ? 'https://github.com' : api.replace(/\/api\/v3$/, '');
}

/** The repository's web URL on the connection's host (GitHub, GHES, GitLab, self-hosted GitLab). */
export function repoWebUrl(target: VcsRepoTarget, urls: VcsApiUrls = {}): string {
  return `${webBaseUrl(target, urls)}/${target.repoOwner}/${target.repoName}`;
}

/** A branch's web URL, using the provider's route (`/tree/` or `/-/tree/`). */
export function branchWebUrl(target: VcsRepoTarget, branch: string, urls: VcsApiUrls = {}): string {
  const route = isGitLab(target) ? '/-/tree/' : '/tree/';
  return `${repoWebUrl(target, urls)}${route}${branch}`;
}

/**
 * BUG-14: the one way to build a VCS provider for a connection. The repository
 * URL and API base follow the connection's provider, so a GitLab connection
 * never reaches GitHub.
 */
export function providerForConnection(
  target: VcsRepoTarget,
  token: string,
  urls: VcsApiUrls = {},
  httpClient?: HttpClient,
): IVcsProvider {
  return createVcsProvider(target.provider, {
    provider: target.provider,
    token,
    repoUrl: repoWebUrl(target, urls),
    githubApiUrl: urls.githubApiUrl,
    gitlabApiUrl: urls.gitlabApiUrl,
    ...(httpClient ? { httpClient } : {}),
  });
}
