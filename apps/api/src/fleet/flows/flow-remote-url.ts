import { ValidationAppException } from '@nathapp/nestjs-common';
import { parseGitHubUrl } from '../../skills/github-url';

export type FlowRemote =
  | { provider: 'github'; owner: string; name: string }
  | { provider: 'gitlab'; url: string };

/** Parse a flow remote without broadening the existing GitHub URL contract. */
export function parseFlowRemoteUrl(url: string): FlowRemote {
  try {
    const github = parseGitHubUrl(url);
    return { provider: 'github', owner: github.owner, name: github.repo };
  } catch {
    // Continue only for a valid HTTPS URL on a non-GitHub host.
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw unsupportedHost();
  }

  if (
    parsed.protocol !== 'https:'
    || parsed.username !== ''
    || parsed.password !== ''
    || parsed.search !== ''
    || parsed.hash !== ''
    || parsed.hostname === 'github.com'
    || parsed.hostname === 'www.github.com'
  ) {
    throw unsupportedHost();
  }

  // URL canonicalizes literal dot segments; reject them from the supplied path as well, rather
  // than accidentally accepting a different repository after that canonicalization.
  const suppliedPath = rawPath(url);
  let path = suppliedPath;
  if (path.endsWith('/')) path = path.slice(0, -1);
  if (/\.git$/i.test(path)) path = path.slice(0, -4);
  const segments = path.startsWith('/') ? path.slice(1).split('/') : path.split('/');
  if (segments.length < 2 || segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    throw unsupportedHost();
  }

  return { provider: 'gitlab', url: (parsed.origin + path).toLowerCase() };
}

function rawPath(url: string): string {
  const schemeEnd = url.indexOf('://');
  if (schemeEnd < 0) return '';
  const authorityStart = schemeEnd + 3;
  const slash = url.indexOf('/', authorityStart);
  if (slash < 0) return '/';
  const query = url.indexOf('?', slash);
  const hash = url.indexOf('#', slash);
  const ends = [query, hash].filter((index) => index >= 0);
  const end = ends.length > 0 ? Math.min(...ends) : url.length;
  return url.slice(slash, end);
}

function unsupportedHost(): ValidationAppException {
  return new ValidationAppException({}, 'skills.unsupportedHost');
}
