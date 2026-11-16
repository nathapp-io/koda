import { promises as dns } from 'node:dns';
import { classifyAddress } from '../../webhook/outbound/address-classifier';
import { RepoCheckException } from './repo-check.exception';

/**
 * US-002 (GitLab parity F1, owner decision A): the host rule of a GitLab repo.
 *
 * A GitLab instance is addressed by its own host, so koda has to know two things about it: that the
 * address is the one the admin meant (a canonical, https-only host) and that the address it resolves
 * to is not an internal one (an SSRF guard, the same classifier the webhook outbound guard uses).
 */

/** The host a GitLab repo without one is addressed at. */
export const DEFAULT_GITLAB_HOST = 'https://gitlab.com';

/**
 * The subnets a self-hosted GitLab may live in: the private ranges an operator runs one on. A public
 * address needs no allow-list entry — the classifier allows it on its own.
 */
const ALLOWED_CIDRS: readonly string[] = ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', 'fc00::/7'];

/**
 * Addresses that are refused whatever the allow-list says. The AWS IPv6 metadata address sits inside
 * `fc00::/7`, and an allow-listed CIDR wins over the blocked ranges in `classifyAddress`, so the
 * literal list is checked first.
 */
const LITERAL_BLOCKED_ADDRESSES: ReadonlySet<string> = new Set(['fd00:ec2::254']);

/**
 * The canonical form of a GitLab host: a lower-case scheme and host, an optional port and path
 * prefix, and no trailing slash. Refuses anything that is not an unambiguous https host — another
 * scheme, userinfo, a query or a fragment — because each of them can point somewhere else than the
 * admin meant.
 */
export function parseGitLabHost(input: string): string {
  const raw = (input ?? '').trim();
  if (raw === '') return DEFAULT_GITLAB_HOST;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new RepoCheckException('gitlab_host_invalid');
  }
  if (url.protocol !== 'https:') throw new RepoCheckException('gitlab_host_invalid');
  if (url.username !== '' || url.password !== '') throw new RepoCheckException('gitlab_host_invalid');
  if (url.search !== '' || url.hash !== '') throw new RepoCheckException('gitlab_host_invalid');
  const path = url.pathname.replace(/\/+$/, '');
  const port = url.port === '' ? '' : `:${url.port}`;
  return `${url.protocol}//${url.hostname.toLowerCase()}${port}${path}`;
}

/**
 * The api base of a host: the host itself plus the GitLab api path. One place builds it, so the
 * registration check and the stored credential always address the same instance.
 */
export function gitlabApiBase(host: string): string {
  return `${host.replace(/\/+$/, '')}/api/v4`;
}

/**
 * True when the host name names a GitLab instance. Until nax #2957 ships, a host without `gitlab`
 * in its name is refused as `gitlab_host_unclassified`.
 */
export function isClassifiableGitLabHost(host: string): boolean {
  return hostnameOf(host).includes('gitlab');
}

/**
 * Refuses a host whose addresses point inside the deployment. Every resolved address is checked: one
 * blocked address is enough to refuse the host.
 */
export async function assertGitLabHostAllowed(host: string): Promise<void> {
  const hostname = hostnameOf(host);
  let addresses: readonly { address: string }[];
  try {
    addresses = await dns.lookup(hostname, { all: true });
  } catch {
    // The host does not resolve: the forge cannot answer either.
    throw new RepoCheckException('provider_unreachable');
  }
  if (addresses.length === 0) throw new RepoCheckException('provider_unreachable');
  for (const { address } of addresses) {
    if (LITERAL_BLOCKED_ADDRESSES.has(address)) throw new RepoCheckException('gitlab_host_blocked');
    if (classifyAddress(address, ALLOWED_CIDRS) === 'blocked') throw new RepoCheckException('gitlab_host_blocked');
  }
}

/**
 * The host name of a host string: a canonical host (`https://gitlab.example.com/gl`) or a bare name.
 * The path and the port are not part of it — only the name is resolved.
 */
function hostnameOf(host: string): string {
  const raw = (host ?? '').trim();
  if (raw === '') throw new RepoCheckException('gitlab_host_invalid');
  let url: URL;
  try {
    url = new URL(raw.includes('://') ? raw : `https://${raw}`);
  } catch {
    throw new RepoCheckException('gitlab_host_invalid');
  }
  return url.hostname.toLowerCase();
}
