import type { FleetRepoRef } from './domain/fleet-job.domain';
import type { ThreadAssign } from '../common/thread-jobs';
import { cloneUrlFor } from '../git-broker/clone-url';
import { fetchableProjectRepos, withProjectRepos } from './project-repos-assign';

/**
 * US-003 (1c-b-D7): the project repositories a PROJECT session's ASSIGN carries. Both functions are pure, so the whole
 * walk — provider, installation, cap, order — is pinned here without a database. `PROJECT_CODE_LIMITS` is
 * `{ maxRepos: 10, maxUnavailable: 50 }`.
 */
const VCS = { githubApiUrl: 'https://api.github.com', gitlabApiUrl: 'https://gitlab.com/api/v4' };

const repo = (over: Partial<FleetRepoRef> = {}): FleetRepoRef => ({
  id: 'r1', projectId: 'p1', provider: 'github', owner: 'acme', name: 'app', defaultBranch: 'main',
  githubInstallationId: 1n, ...over,
});

const thread: ThreadAssign = {
  threadId: 't1', action: 'SESSION', kind: 'PROJECT', feature: 'thread-t1', resume: false, instructions: 'go',
  backend: { kind: 'native', model: 'm1' }, skills: [], initialMessage: null,
};

/** `n` installed GitHub repositories, in input order. */
const githubRepos = (n: number): FleetRepoRef[] =>
  Array.from({ length: n }, (_, i) => repo({ id: `r${i + 1}`, owner: 'acme', name: `app${i + 1}` }));

/** `n` GitLab repositories, in input order. */
const gitlabRepos = (n: number, connected = false): FleetRepoRef[] =>
  Array.from({ length: n }, (_, i) => repo({ id: `g${i + 1}`, provider: 'gitlab', owner: 'acme', name: `gl${i + 1}`, githubInstallationId: null, gitlabWriteUser: connected ? { id: 7, username: 'kodabot' } : null }));

describe('fetchableProjectRepos (US-003)', () => {
  it('returns the installed GitHub repositories in input order', () => {
    const a = repo({ id: 'a' });
    const b = repo({ id: 'b', provider: 'gitlab', githubInstallationId: null });
    const c = repo({ id: 'c', githubInstallationId: null });
    const d = repo({ id: 'd' });
    expect(fetchableProjectRepos([a, b, c, d]).map((r) => r.id)).toEqual(['a', 'd']);
  });

  it('AC-2: keeps only installed GitHub and connected GitLab repos in input order', () => {
    const gh = repo({ id: 'gh' });
    const connected = gitlabRepos(1, true)[0];
    const disconnected = gitlabRepos(1)[0];
    const legacy = { ...gitlabRepos(1)[0] };
    delete (legacy as Partial<FleetRepoRef>).gitlabWriteUser;
    const noInstall = repo({ id: 'no-install', githubInstallationId: null });

    expect(fetchableProjectRepos([gh, disconnected, legacy, connected, noInstall]).map((item) => item.id)).toEqual(['gh', 'g1']);
  });

  it('keeps at most 10 repositories', () => {
    expect(fetchableProjectRepos(githubRepos(12)).map((r) => r.id)).toEqual(githubRepos(10).map((r) => r.id));
  });

  it('returns an empty list for a project with no fetchable repository', () => {
    expect(fetchableProjectRepos(gitlabRepos(3))).toEqual([]);
    expect(fetchableProjectRepos([])).toEqual([]);
  });

  it('AC-3: includes a connected GitLab repo with its host-specific clone URL', () => {
    const gitlab = repo({ id: 'gl', provider: 'gitlab', owner: 'team', name: 'app', githubInstallationId: null,
      host: 'https://gitlab.example.com', gitlabWriteUser: { id: 7, username: 'kodabot' } });
    expect(withProjectRepos(thread, [gitlab], VCS).projectRepos).toEqual([
      { repoId: 'gl', owner: 'team', name: 'app', defaultBranch: 'main', cloneUrl: 'https://gitlab.example.com/team/app.git' },
    ]);
  });
});

describe('withProjectRepos (US-003 AC-1, AC-2)', () => {
  it('AC-1: carries the one installed GitHub repository with its clone url, owner, name and branch', () => {
    const a = repo({ id: 'a', owner: 'acme', name: 'app', defaultBranch: 'trunk' });
    const b = repo({ id: 'b', provider: 'gitlab', owner: 'acme', name: 'gl', githubInstallationId: null });
    const c = repo({ id: 'c', owner: 'acme', name: 'other', githubInstallationId: null });

    const result = withProjectRepos(thread, [a, b, c], VCS);

    expect(result.projectRepos).toEqual([
      { repoId: 'a', owner: 'acme', name: 'app', defaultBranch: 'trunk', cloneUrl: cloneUrlFor(a, VCS) },
    ]);
    expect(result.projectRepos?.[0]?.cloneUrl).toBe('https://github.com/acme/app.git');
  });

  it('AC-1: leaves the rest of the thread block untouched', () => {
    const result = withProjectRepos(thread, [repo({ id: 'a' })], VCS);
    expect(result).toEqual({ ...thread, projectRepos: expect.any(Array), projectReposUnavailable: expect.any(Array) });
    expect(result.instructions).toBe(thread.instructions);
    expect(result.kind).toBe('PROJECT');
  });

  it('AC-4: lists a GitLab repo without credentials as no installation', () => {
    const gitlab = repo({ id: 'gl', provider: 'gitlab', owner: 'acme', name: 'gl', githubInstallationId: null, gitlabWriteUser: null });
    expect(withProjectRepos(thread, [gitlab], VCS).projectReposUnavailable).toEqual([
      { owner: 'acme', name: 'gl', reason: 'no installation' },
    ]);
  });

  it('AC-2: lists each unavailable repository in input order with its reason', () => {
    const a = repo({ id: 'a' });
    const b = repo({ id: 'b', provider: 'gitlab', owner: 'acme', name: 'gl', githubInstallationId: null });
    const c = repo({ id: 'c', owner: 'acme', name: 'other', githubInstallationId: null });

    const result = withProjectRepos(thread, [a, b, c], VCS);

    expect(result.projectReposUnavailable).toEqual([
      { owner: 'acme', name: 'gl', reason: 'no installation' },
      { owner: 'acme', name: 'other', reason: 'no installation' },
    ]);
  });

  it('sets both arrays, empty for a project with no repository', () => {
    expect(withProjectRepos(thread, [], VCS)).toEqual({ ...thread, projectRepos: [], projectReposUnavailable: [] });
  });
});

describe('withProjectRepos caps (US-003 AC-3, AC-4)', () => {
  it('AC-5: marks a connected GitLab repo after ten GitHub repos as limit', () => {
    const repos = [...githubRepos(10), ...gitlabRepos(1, true)];
    const result = withProjectRepos(thread, repos, VCS);
    expect(result.projectRepos).toHaveLength(10);
    expect(result.projectReposUnavailable).toEqual([{ owner: 'acme', name: 'gl1', reason: 'limit' }]);
  });

  it('AC-3: takes the first 10 of 12 installed repositories and marks the rest `limit`', () => {
    const repos = githubRepos(12);

    const result = withProjectRepos(thread, repos, VCS);

    expect(result.projectRepos?.map((r) => r.repoId)).toEqual(repos.slice(0, 10).map((r) => r.id));
    expect(result.projectRepos?.[9]?.cloneUrl).toBe('https://github.com/acme/app10.git');
    expect(result.projectReposUnavailable).toEqual([
      { owner: 'acme', name: 'app11', reason: 'limit' },
      { owner: 'acme', name: 'app12', reason: 'limit' },
    ]);
  });

  it('AC-4: keeps exactly 50 unavailable entries for 60 GitLab repositories', () => {
    const repos = gitlabRepos(60);

    const result = withProjectRepos(thread, repos, VCS);

    expect(result.projectRepos).toEqual([]);
    expect(result.projectReposUnavailable).toHaveLength(50);
    expect(result.projectReposUnavailable?.[0]).toEqual({ owner: 'acme', name: 'gl1', reason: 'no installation' });
    expect(result.projectReposUnavailable?.[49]).toEqual({ owner: 'acme', name: 'gl50', reason: 'no installation' });
  });

  it('AC-4: drops the unavailable entries past the cap instead of the fetchable ones', () => {
    const repos = [...gitlabRepos(55), ...githubRepos(3).map((r, i) => ({ ...r, id: `x${i + 1}` }))];

    const result = withProjectRepos(thread, repos, VCS);

    expect(result.projectRepos?.map((r) => r.repoId)).toEqual(['x1', 'x2', 'x3']);
    expect(result.projectReposUnavailable).toHaveLength(50);
  });

  it('counts only the fetchable repositories against maxRepos, never the unavailable ones', () => {
    const repos = [repo({ id: 'gl-first', provider: 'gitlab', owner: 'acme', name: 'gl1', githubInstallationId: null }), ...githubRepos(10), repo({ id: 'last', name: 'last' })];

    const result = withProjectRepos(thread, repos, VCS);

    expect(result.projectRepos).toHaveLength(10);
    expect(result.projectReposUnavailable).toEqual([
      { owner: 'acme', name: 'gl1', reason: 'no installation' },
      { owner: 'acme', name: 'last', reason: 'limit' },
    ]);
  });
});
