/** The repository a VCS connection points at. */
export interface VcsRepoRef {
  repoOwner: string;
  repoName: string;
}

/**
 * M11: the external id stored on a ticket imported from a VCS issue. Qualified
 * as `owner/repo#N`, so issue numbers from two repositories never collide.
 */
export function externalVcsIdFor(repo: VcsRepoRef, issueNumber: number): string {
  return `${repo.repoOwner}/${repo.repoName}#${issueNumber}`;
}
