import { GitTokenBroker } from './git-token.broker';
import { RepoCheckException } from './repo-check.exception';
import type { FleetRepoRef } from '../jobs/domain/fleet-job.domain';

const repo: FleetRepoRef = { id: 'r', projectId: 'p', provider: 'github', owner: 'acme', name: 'app', defaultBranch: 'main', githubInstallationId: BigInt(77) };
const gitlab: FleetRepoRef = { ...repo, provider: 'gitlab', githubInstallationId: null };
const NOW = new Date('2026-10-01T00:00:00.000Z');
const minted = { token: 'minted', expiresAt: new Date(NOW.getTime() + 60 * 60_000) };

describe('GitTokenBroker job purposes', () => {
  const github = { mintInstallationToken: vi.fn(), mintReadOnlyToken: vi.fn(), mintReviewToken: vi.fn(), isBranchProtected: vi.fn() };
  const gitlabClient = { resolve: vi.fn() };
  let broker: GitTokenBroker;

  beforeEach(() => {
    vi.resetAllMocks();
    github.mintInstallationToken.mockResolvedValue(minted);
    github.mintReadOnlyToken.mockResolvedValue({ token: 'readonly', expiresAt: minted.expiresAt });
    github.mintReviewToken.mockResolvedValue({ token: 'review', expiresAt: minted.expiresAt });
    github.isBranchProtected.mockResolvedValue(true);
    broker = new GitTokenBroker({ gitTokenReuseMarginSec: 300, gitlabTokenTtlSec: 3600 }, github as never, gitlabClient as never);
  });

  it('AC-1, AC-2: mints a review token and never a write token', async () => {
    const result = await broker.mint({ jobId: 'j1', leaseEpoch: 1, repo, purpose: 'review' }, NOW);
    expect(result).toEqual({ ok: true, token: { jobId: 'j1', token: 'review', username: 'x-access-token', expiresAt: minted.expiresAt.toISOString() } });
    expect(github.mintReviewToken).toHaveBeenCalledTimes(1);
    expect(github.mintReviewToken).toHaveBeenCalledWith(repo.githubInstallationId, repo.name);
    expect(github.mintInstallationToken).not.toHaveBeenCalled();
  });

  it('AC-3: does not reuse review credential for a write mint', async () => {
    await broker.mint({ jobId: 'j1', leaseEpoch: 1, repo, purpose: 'review' }, NOW);
    await broker.mint({ jobId: 'j1', leaseEpoch: 1, repo }, NOW);
    expect(github.mintInstallationToken).toHaveBeenCalledTimes(1);
  });

  it('AC-4, AC-5: refuses a FIX mint on an unprotected default branch before write mint', async () => {
    github.isBranchProtected.mockResolvedValue(false);
    await expect(broker.mint({ jobId: 'j1', leaseEpoch: 1, repo, purpose: 'fix' }, NOW)).resolves.toEqual({
      ok: false, error: { jobId: 'j1', reason: 'default_branch_unprotected' },
    });
    expect(github.mintInstallationToken).not.toHaveBeenCalled();
  });

  it('AC-6, AC-7, AC-8: checks protection with a read-only token before minting FIX write credentials', async () => {
    const result = await broker.mint({ jobId: 'j1', leaseEpoch: 1, repo, purpose: 'fix' }, NOW);
    expect(github.isBranchProtected).toHaveBeenCalledWith('readonly', repo.owner, repo.name, repo.defaultBranch);
    expect(github.mintInstallationToken).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ ok: true });
  });

  it('FIX purpose still returns a write credential when readOnly is also true', async () => {
    const result = await broker.mint({ jobId: 'j1', leaseEpoch: 1, repo, purpose: 'fix', readOnly: true }, NOW);
    expect(github.isBranchProtected).toHaveBeenCalledWith('readonly', repo.owner, repo.name, repo.defaultBranch);
    expect(github.mintInstallationToken).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ ok: true, token: { jobId: 'j1', token: 'minted', username: 'x-access-token', expiresAt: minted.expiresAt.toISOString() } });
  });

  it('AC-9, AC-10: maps protection-check errors and never mints a write token', async () => {
    github.isBranchProtected.mockRejectedValue(new RepoCheckException('provider_error'));
    await expect(broker.mint({ jobId: 'j1', leaseEpoch: 1, repo, purpose: 'fix' }, NOW)).resolves.toEqual({
      ok: false, error: { jobId: 'j1', reason: 'provider_error' },
    });
    expect(github.mintInstallationToken).not.toHaveBeenCalled();
  });

  it.each(['review', 'fix'] as const)('AC-11, AC-12: rejects GitLab %s purpose before resolving stored credentials', async (purpose) => {
    await expect(broker.mint({ jobId: 'j1', leaseEpoch: 1, repo: gitlab, purpose }, NOW)).resolves.toEqual({
      ok: false, error: { jobId: 'j1', reason: 'provider_error' },
    });
    expect(gitlabClient.resolve).not.toHaveBeenCalled();
    expect(github.mintInstallationToken).not.toHaveBeenCalled();
  });

  it('AC-13: preserves read-only token repository attribution without a purpose', async () => {
    await expect(broker.mint({ jobId: 'j1', leaseEpoch: 1, repo, readOnly: true }, NOW)).resolves.toEqual({
      ok: true, token: { jobId: 'j1', repoId: repo.id, token: 'readonly', username: 'x-access-token', expiresAt: minted.expiresAt.toISOString() },
    });
  });

  it('AC-14: reuses read-only tokens within the existing reuse margin', async () => {
    const request = { jobId: 'j1', leaseEpoch: 1, repo, readOnly: true };
    const first = await broker.mint(request, NOW);
    const second = await broker.mint(request, new Date(NOW.getTime() + 54 * 60_000));
    expect(second).toEqual(first);
    expect(github.mintReadOnlyToken).toHaveBeenCalledTimes(1);
  });
});
