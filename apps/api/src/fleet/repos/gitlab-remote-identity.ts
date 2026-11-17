import type { GitLabRemoteIdentity } from './domain/fleet-repo.domain';

/**
 * The most path segments a canonical GitLab remote may carry. Every extra segment is another
 * identity the lookup has to try, so a remote with more segments than this is refused rather than
 * half-matched.
 */
const MAX_REMOTE_SEGMENTS = 32;

/**
 * The identities a canonical GitLab remote URL can name.
 *
 * A remote URL is `host + '/' + owner + '/' + name`, but the host itself may carry a path prefix (a
 * self-hosted instance under a sub-path) and the namespace may carry slashes of its own, so the URL
 * alone does not say where the host ends and the namespace begins. Every split of its path is a
 * possible identity, and the registered row is the one that carries it: with `k` path segments the
 * host takes 0..k-2 of them and the namespace takes the rest.
 *
 * The identities carry the *complete* identity of a repo (host, namespace and name), so a lookup
 * filters on all of it before it reads a bounded page of rows: a name that repeats on other hosts
 * or namespaces can no longer push the registered repo out of that page.
 */
export function gitLabRemoteIdentities(url: string): GitLabRemoteIdentity[] {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return [];
  }
  // A canonical remote is an https URL without credentials, query or fragment. A stored host is a
  // canonical https host, so anything else names no registered row.
  if (parsed.protocol !== 'https:' || parsed.username !== '' || parsed.password !== ''
    || parsed.search !== '' || parsed.hash !== '') {
    return [];
  }
  const path = parsed.pathname.startsWith('/') ? parsed.pathname.slice(1) : parsed.pathname;
  const segments = path.split('/');
  if (segments.length < 2 || segments.length > MAX_REMOTE_SEGMENTS) return [];
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) return [];

  const name = segments[segments.length - 1];
  const identities: GitLabRemoteIdentity[] = [];
  for (let prefix = 0; prefix <= segments.length - 2; prefix++) {
    identities.push({
      host: prefix === 0 ? parsed.origin : `${parsed.origin}/${segments.slice(0, prefix).join('/')}`,
      owner: segments.slice(prefix, segments.length - 1).join('/'),
      name,
    });
  }
  return identities;
}
