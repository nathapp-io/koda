/**
 * Build a clickable source URL from a project's git remote URL + file ref.
 * Supports GitHub and GitLab.
 *
 * @example
 * buildGitUrl('https://github.com/nathapp-io/koda', 'v1.0', 'apps/api/src/auth.ts', 42)
 * // => 'https://github.com/nathapp-io/koda/blob/v1.0/apps/api/src/auth.ts#L42'
 *
 * buildGitUrl('https://gitlab.com/nathapp/koda', 'main', 'apps/api/src/auth.ts')
 * // => 'https://gitlab.com/nathapp/koda/-/blob/main/apps/api/src/auth.ts'
 */
export function buildGitUrl(
  gitRemoteUrl: string | null | undefined,
  ref: string,
  filePath: string,
  line?: number,
): string | null {
  if (!gitRemoteUrl) return null;
  // Normalise: strip trailing .git
  const base = gitRemoteUrl.replace(/\.git$/, '').replace(/\/$/, '');
  const isGitLab = base.includes('gitlab.com');
  const lineFragment = line ? `#L${line}` : '';
  if (isGitLab) {
    return `${base}/-/blob/${ref}/${filePath}${lineFragment}`;
  }
  // Default: GitHub
  return `${base}/blob/${ref}/${filePath}${lineFragment}`;
}