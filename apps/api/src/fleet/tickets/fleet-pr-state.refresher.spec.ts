import { FleetPrStateRefresher } from './fleet-pr-state.refresher';
import { RepoCheckException } from '../git-broker/repo-check.exception';
import { testFleetConfig } from '../../common/test-helpers/fleet-config';

const gh = { id: 'r1', projectId: 'p', provider: 'github' as const, owner: 'acme', name: 'app', githubInstallationId: BigInt(77) };
const gl = { id: 'r2', projectId: 'p', provider: 'gitlab' as const, owner: 'grp', name: 'lib', githubInstallationId: null };
const link = (id: string, prNumber: number, repo: typeof gh | typeof gl = gh, prState = 'open') => ({
  id, ticketId: `t-${id}`, url: `u${prNumber}`, prNumber, prState, externalRef: `${repo.owner}/${repo.name}#${prNumber}`, source: 'fleet',
  ticket: { id: `t-${id}`, status: 'IN_PROGRESS', projectId: 'p', number: 1, externalVcsId: null }, repo,
});
const pr = (over: Record<string, unknown> = {}) => ({
  number: 1, state: 'open', draft: false, merged: false, mergedAt: null, mergedBy: null, mergeSha: null, url: 'u', title: 't', ...over,
});

describe('FleetPrStateRefresher (C9 §3.4, D456)', () => {
  let repo: { findRefreshableFleetLinks: jest.Mock };
  let github: { mintInstallationToken: jest.Mock; getPullRequest: jest.Mock };
  let gitlab: { getMergeRequest: jest.Mock };
  let gitlabTokens: { resolve: jest.Mock };
  let vcsRepo: { updateTicketLinkWithPrState: jest.Mock };
  let prSync: { applyMergedPr: jest.Mock };
  let refresher: FleetPrStateRefresher;

  beforeEach(() => {
    repo = { findRefreshableFleetLinks: jest.fn().mockResolvedValue([]) };
    github = { mintInstallationToken: jest.fn().mockResolvedValue({ token: 'ghs', expiresAt: new Date() }), getPullRequest: jest.fn().mockResolvedValue(pr()) };
    gitlab = { getMergeRequest: jest.fn().mockResolvedValue(pr()) };
    gitlabTokens = { resolve: jest.fn().mockResolvedValue('glpat') };
    vcsRepo = { updateTicketLinkWithPrState: jest.fn().mockResolvedValue('updated') };
    prSync = { applyMergedPr: jest.fn().mockResolvedValue('updated') };
    refresher = new FleetPrStateRefresher(
      repo as never, github as never, gitlab as never, gitlabTokens as never, vcsRepo as never, prSync as never, testFleetConfig(),
    );
  });

  it('mints one GitHub token per repo and reads each PR with it', async () => {
    repo.findRefreshableFleetLinks.mockResolvedValue([link('a', 1), link('b', 2)]);
    await refresher.refresh();
    expect(github.mintInstallationToken).toHaveBeenCalledTimes(1);
    expect(github.mintInstallationToken).toHaveBeenCalledWith(BigInt(77), 'app');
    expect(github.getPullRequest.mock.calls).toEqual([['ghs', 'acme', 'app', 1], ['ghs', 'acme', 'app', 2]]);
  });

  it('reads GitLab MRs with the project token', async () => {
    repo.findRefreshableFleetLinks.mockResolvedValue([link('a', 4, gl)]);
    await refresher.refresh();
    expect(gitlabTokens.resolve).toHaveBeenCalledWith('p', 'grp', 'lib');
    expect(gitlab.getMergeRequest).toHaveBeenCalledWith('glpat', 'grp', 'lib', 4);
  });

  it('writes a changed state, skips an unchanged one, and closes a 404', async () => {
    repo.findRefreshableFleetLinks.mockResolvedValue([link('a', 1), link('b', 2), link('c', 3)]);
    github.getPullRequest.mockResolvedValueOnce(pr({ draft: true })).mockResolvedValueOnce(pr()).mockResolvedValueOnce(null);
    await expect(refresher.refresh()).resolves.toEqual({ skipped: false, checked: 3, changed: 2, failedRepos: 0 });
    expect(vcsRepo.updateTicketLinkWithPrState.mock.calls).toEqual([['a', 'draft'], ['c', 'closed']]);
  });

  it('routes a merge through the shared merge step, not a plain write', async () => {
    const l = link('a', 1);
    repo.findRefreshableFleetLinks.mockResolvedValue([l]);
    github.getPullRequest.mockResolvedValue(pr({ state: 'closed', merged: true }));
    await refresher.refresh();
    expect(prSync.applyMergedPr).toHaveBeenCalledWith(l, expect.objectContaining({ merged: true }));
    expect(vcsRepo.updateTicketLinkWithPrState).not.toHaveBeenCalled();
  });

  it('skips a repo whose token cannot be minted and still refreshes the others', async () => {
    repo.findRefreshableFleetLinks.mockResolvedValue([link('a', 1), link('b', 4, gl)]);
    github.mintInstallationToken.mockRejectedValue(new RepoCheckException('app_not_installed'));
    gitlab.getMergeRequest.mockResolvedValue(pr({ state: 'closed' }));
    await expect(refresher.refresh()).resolves.toEqual({ skipped: false, checked: 1, changed: 1, failedRepos: 1 });
    expect(vcsRepo.updateTicketLinkWithPrState).toHaveBeenCalledWith('b', 'closed');
  });

  it('counts a GitHub repo without an installation id as failed', async () => {
    repo.findRefreshableFleetLinks.mockResolvedValue([link('a', 1, { ...gh, githubInstallationId: null })]);
    await expect(refresher.refresh()).resolves.toEqual(expect.objectContaining({ failedRepos: 1, checked: 0 }));
  });

  it('a failed PR read skips that link only', async () => {
    repo.findRefreshableFleetLinks.mockResolvedValue([link('a', 1), link('b', 2)]);
    github.getPullRequest.mockRejectedValueOnce(new RepoCheckException('provider_error')).mockResolvedValueOnce(pr({ state: 'closed' }));
    await refresher.refresh();
    expect(vcsRepo.updateTicketLinkWithPrState.mock.calls).toEqual([['b', 'closed']]);
  });

  it('skips a pass while one is running', async () => {
    let release: () => void = () => undefined;
    repo.findRefreshableFleetLinks.mockReturnValue(new Promise((resolve) => { release = () => resolve([]); }));
    const first = refresher.refresh();
    await expect(refresher.refresh()).resolves.toEqual({ skipped: true, checked: 0, changed: 0, failedRepos: 0 });
    release();
    await expect(first).resolves.toEqual(expect.objectContaining({ skipped: false }));
  });

  it('never throws when the link query fails', async () => {
    repo.findRefreshableFleetLinks.mockRejectedValue(new Error('db down'));
    await expect(refresher.refresh()).resolves.toEqual({ skipped: false, checked: 0, changed: 0, failedRepos: 0 });
  });

  it('starts no timer when background work is off (plan P3)', () => {
    const spy = jest.spyOn(global, 'setInterval');
    refresher.onModuleInit();
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
