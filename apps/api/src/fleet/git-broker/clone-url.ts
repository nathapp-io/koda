/** Web base of a forge from its REST API base: api.github.com -> github.com, strip /api/vN. */
export function forgeWebBase(apiUrl: string): string {
  const url = new URL(apiUrl);
  if (url.hostname.startsWith('api.')) url.hostname = url.hostname.slice('api.'.length);
  url.pathname = url.pathname.replace(/\/+$/, '').replace(/\/api\/v\d+$/, '');
  return url.toString().replace(/\/+$/, '');
}

/**
 * The web base of a repo's own host (US-003): the host as it is stored, without a trailing slash.
 * A path prefix is part of it — an instance under `/gitlab` clones from `/gitlab/...`.
 */
function hostWebBase(host: string): string {
  return host.trim().replace(/\/+$/, '');
}

/** A GitLab repo is cloned from its own host; a repo without one from the configured GitLab base. */
function gitlabBase(repo: { host?: string }, cfg: { gitlabApiUrl: string }): string {
  return repo.host !== undefined && repo.host.trim() !== '' ? hostWebBase(repo.host) : forgeWebBase(cfg.gitlabApiUrl);
}

/**
 * HTTPS clone url; git credentials come from the per-job helper (spec §7.2), never the url.
 *
 * US-003: a GitLab repo is cloned from its own host, because the same owner and name can exist on
 * two GitLab hosts. A repo without a host falls back to the configured GitLab base, and a GitHub
 * repo is always cloned from the configured GitHub base, whatever host its row carries.
 */
export function cloneUrlFor(
  repo: { provider: 'github' | 'gitlab'; owner: string; name: string; host?: string },
  cfg: { githubApiUrl: string; gitlabApiUrl: string },
): string {
  const base = repo.provider === 'github' ? forgeWebBase(cfg.githubApiUrl) : gitlabBase(repo, cfg);
  return `${base}/${repo.owner}/${repo.name}.git`;
}
