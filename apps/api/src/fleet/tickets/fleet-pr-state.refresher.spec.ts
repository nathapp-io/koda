import type { Mock } from 'vitest';
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
  let repo: { findRefreshableFleetLinks: Mock };
  let github: { mintInstallationToken: Mock; getPullRequest: Mock };
  let gitlab: { getMergeRequest: Mock };
  let gitlabTokens: { resolve: Mock };
  let vcsRepo: { updateTicketLinkWithPrState: Mock };
  let prSync: { applyMergedPr: Mock };
  let knowledge: { enqueue: Mock };
  let refresher: FleetPrStateRefresher;

  beforeEach(() => {
    repo = { findRefreshableFleetLinks: vi.fn().mockResolvedValue([]) };
    github = { mintInstallationToken: vi.fn().mockResolvedValue({ token: 'ghs', expiresAt: new Date() }), getPullRequest: vi.fn().mockResolvedValue(pr()) };
    gitlab = { getMergeRequest: vi.fn().mockResolvedValue(pr()) };
    gitlabTokens = { resolve: vi.fn().mockResolvedValue('glpat') };
    vcsRepo = { updateTicketLinkWithPrState: vi.fn().mockResolvedValue('updated') };
    prSync = { applyMergedPr: vi.fn().mockResolvedValue('updated') };
    knowledge = { enqueue: vi.fn() };
    refresher = new FleetPrStateRefresher(
      repo as never, github as never, gitlab as never, gitlabTokens as never, vcsRepo as never, prSync as never,
      testFleetConfig(), knowledge as never,
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
    const spy = vi.spyOn(global, 'setInterval');
    refresher.onModuleInit();
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  // ── S5b US-005 (1c-c-D11): a merge is the repository-knowledge freshness hook ─────────────────────────
  /** The refreshed link of the S5b fixture: repository r9, PR open, reported merged by the GitHub stub. */
  const merged = (prState = 'open') => {
    const repo9 = { ...gh, id: 'r9' };
    const l = link('a', 1, repo9, prState);
    repo.findRefreshableFleetLinks.mockResolvedValue([l]);
    github.getPullRequest.mockResolvedValue(pr({ state: 'closed', merged: true }));
    return l;
  };

  it('AC-8: enqueues the repository once when a PR merge was applied', async () => {
    merged();

    await refresher.refresh();

    expect(prSync.applyMergedPr).toHaveBeenCalledTimes(1);
    expect(knowledge.enqueue).toHaveBeenCalledTimes(1);
    expect(knowledge.enqueue).toHaveBeenCalledWith('r9', 'merge');
  });

  it('AC-15: a merge keeps the pass summary and the shared merge write', async () => {
    merged();

    await expect(refresher.refresh()).resolves.toEqual({ skipped: false, checked: 1, changed: 1, failedRepos: 0 });

    expect(vcsRepo.updateTicketLinkWithPrState).not.toHaveBeenCalled();
    expect(knowledge.enqueue).toHaveBeenCalledWith('r9', 'merge');
  });

  it('AC-9: does not enqueue for a link that is already merged', async () => {
    merged('merged');

    await expect(refresher.refresh()).resolves.toEqual({ skipped: false, checked: 1, changed: 0, failedRepos: 0 });

    expect(knowledge.enqueue).not.toHaveBeenCalled();
  });

  it('AC-10: does not enqueue for a PR that closed without merging', async () => {
    const l = link('a', 1, { ...gh, id: 'r9' });
    repo.findRefreshableFleetLinks.mockResolvedValue([l]);
    github.getPullRequest.mockResolvedValue(pr({ state: 'closed' }));

    await expect(refresher.refresh()).resolves.toEqual({ skipped: false, checked: 1, changed: 1, failedRepos: 0 });

    expect(vcsRepo.updateTicketLinkWithPrState).toHaveBeenCalledWith('a', 'closed');
    expect(knowledge.enqueue).not.toHaveBeenCalled();
  });

  it('does not enqueue when the merge step refused to update (a lost race)', async () => {
    merged();
    prSync.applyMergedPr.mockResolvedValue(undefined);

    await refresher.refresh();

    expect(knowledge.enqueue).not.toHaveBeenCalled();
  });
});
