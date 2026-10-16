import { PROJECT_CODE_LIMITS, type ProjectRepoAssign, type ProjectRepoUnavailable, type ThreadAssign } from '../common/thread-jobs';
import type { FleetRepoRef } from './domain/fleet-job.domain';
import { cloneUrlFor } from '../git-broker/clone-url';

/**
 * Fleet S5b 1c-b-D7: the repositories a PROJECT session reads, and the ones it cannot, as the ASSIGN carries them.
 *
 * Both functions are pure and share one walk over the project's repositories (the anchor order the repository reads
 * them in), so the list the ASSIGN publishes and the list the token fence recomputes (US-002) can never disagree: a
 * repository the walk drops — GitLab, no installation, past the cap — is exactly a repository no token is minted for.
 */

/**
 * The project's repositories a session can fetch: GitHub, with an installation, in input order, at most `maxRepos`.
 * The token fence (1c-b-D5) reads this same list to decide which `repoId`s it may grant.
 */
export function fetchableProjectRepos(repos: readonly FleetRepoRef[]): FleetRepoRef[] {
  return repos
    .filter((repo) => repo.provider === 'github' && repo.githubInstallationId !== null)
    .slice(0, PROJECT_CODE_LIMITS.maxRepos);
}

/**
 * The thread block with `projectRepos` (fetchable, at most 10) and `projectReposUnavailable` (at most 50) set: the
 * first 50 repositories the walk cannot fetch, each with the reason the agent is told. A repository past the cap is
 * `limit`; the runner refuses an over-long list (US-004), so the cap is enforced here, never by the runner.
 */
export function withProjectRepos(
  thread: ThreadAssign,
  repos: readonly FleetRepoRef[],
  vcs: { githubApiUrl: string; gitlabApiUrl: string },
): ThreadAssign {
  const projectRepos: ProjectRepoAssign[] = [];
  const unavailable: ProjectRepoUnavailable[] = [];
  for (const repo of repos) {
    const reason = unavailableReason(repo);
    if (reason !== null) {
      unavailable.push({ owner: repo.owner, name: repo.name, reason });
    } else if (projectRepos.length < PROJECT_CODE_LIMITS.maxRepos) {
      projectRepos.push({
        repoId: repo.id, owner: repo.owner, name: repo.name, defaultBranch: repo.defaultBranch,
        cloneUrl: cloneUrlFor(repo, vcs),
      });
    } else {
      unavailable.push({ owner: repo.owner, name: repo.name, reason: 'limit' });
    }
  }
  return { ...thread, projectRepos, projectReposUnavailable: unavailable.slice(0, PROJECT_CODE_LIMITS.maxUnavailable) };
}

/** Why this repository is not fetchable at all, or null when it is. */
function unavailableReason(repo: FleetRepoRef): ProjectRepoUnavailable['reason'] | null {
  if (repo.provider !== 'github') return 'not a GitHub repository';
  if (repo.githubInstallationId === null) return 'no installation';
  return null;
}
