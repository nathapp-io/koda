/** Web base of a forge from its REST API base: api.github.com -> github.com, strip /api/vN. */
export function forgeWebBase(apiUrl: string): string {
  const url = new URL(apiUrl);
  if (url.hostname.startsWith('api.')) url.hostname = url.hostname.slice('api.'.length);
  url.pathname = url.pathname.replace(/\/+$/, '').replace(/\/api\/v\d+$/, '');
  return url.toString().replace(/\/+$/, '');
}

/** HTTPS clone url; git credentials come from the per-job helper (spec §7.2), never the url. */
export function cloneUrlFor(
  repo: { provider: 'github' | 'gitlab'; owner: string; name: string },
  cfg: { githubApiUrl: string; gitlabApiUrl: string },
): string {
  const base = forgeWebBase(repo.provider === 'github' ? cfg.githubApiUrl : cfg.gitlabApiUrl);
  return `${base}/${repo.owner}/${repo.name}.git`;
}
