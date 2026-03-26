/**
 * Parsed link information extracted from a URL.
 */
export interface ParsedLink {
  provider: 'github' | 'gitlab' | 'bitbucket' | 'other';
  externalRef: string | null;
}

/**
 * Detect VCS provider from a URL and extract provider-specific reference.
 * Supports GitHub, GitLab, and Bitbucket PR/MR URLs.
 *
 * @example
 * detectProvider('https://github.com/owner/repo/pull/42')
 * // => { provider: 'github', externalRef: 'owner/repo#42' }
 *
 * detectProvider('not-a-url')
 * // => { provider: 'other', externalRef: null }
 */
export function detectProvider(url: string): ParsedLink {
  if (!url) {
    return { provider: 'other', externalRef: null };
  }

  try {
    const urlObj = new URL(url);
    const hostname = urlObj.hostname.replace(/^www\./, '');
    const pathname = urlObj.pathname.replace(/\/$/, '');

    // GitHub: https://github.com/owner/repo/pull/42
    if (hostname === 'github.com') {
      const match = pathname.match(/^\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
      if (match) {
        const [, owner, repo, prNumber] = match;
        return {
          provider: 'github',
          externalRef: `${owner}/${repo}#${prNumber}`,
        };
      }
    }

    // GitLab: https://gitlab.com/owner/repo/-/merge_requests/7
    if (hostname === 'gitlab.com') {
      const match = pathname.match(/^\/([^/]+)\/([^/]+)\/-\/merge_requests\/(\d+)/);
      if (match) {
        const [, owner, repo, mrNumber] = match;
        return {
          provider: 'gitlab',
          externalRef: `${owner}/${repo}#${mrNumber}`,
        };
      }
    }

    // Bitbucket: https://bitbucket.org/owner/repo/pull-requests/3
    if (hostname === 'bitbucket.org') {
      const match = pathname.match(
        /^\/([^/]+)\/([^/]+)\/pull-requests\/(\d+)/,
      );
      if (match) {
        const [, owner, repo, prNumber] = match;
        return {
          provider: 'bitbucket',
          externalRef: `${owner}/${repo}#${prNumber}`,
        };
      }
    }

    // Unknown provider or URL format
    return { provider: 'other', externalRef: null };
  } catch {
    // Invalid URL
    return { provider: 'other', externalRef: null };
  }
}
