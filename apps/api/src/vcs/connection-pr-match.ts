/** The repo a `VcsConnection` watches; a `VcsConnectionDomain` satisfies it. */
export interface ConnectionRepo {
  repoOwner: string;
  repoName: string;
}

const REF = /^(.+)#(\d+)$/;

/**
 * Fleet C9 §3.6 (D458): a PR link belongs to the connection's repo when its externalRef is
 * `<repoOwner>/<repoName>#<prNumber>` (case-insensitive). A row without externalRef predates
 * repo-scoped links and matches by number only, and only when it came from VCS.
 */
export function linkMatchesConnection(
  link: { externalRef: string | null; prNumber: number | null; source?: string },
  repo: ConnectionRepo,
): boolean {
  if (link.externalRef === null) return (link.source ?? 'vcs') === 'vcs';
  const match = REF.exec(link.externalRef);
  if (!match) return false;
  return match[1].toLowerCase() === `${repo.repoOwner}/${repo.repoName}`.toLowerCase() && Number(match[2]) === link.prNumber;
}
