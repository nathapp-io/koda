import { GitTokenBroker } from './git-token.broker';
import { RepoCheckException } from './repo-check.exception';
import { GitLabAccessChecker } from './gitlab-access-checker';
import type { FleetRepoRef } from '../jobs/domain/fleet-job.domain';

const repo: FleetRepoRef = { id: 'r', projectId: 'p', provider: 'github', owner: 'acme', name: 'app', defaultBranch: 'main', githubInstallationId: BigInt(77) };
const gitlab: FleetRepoRef = { ...repo, provider: 'gitlab', githubInstallationId: null };
const NOW = new Date('2026-10-01T00:00:00.000Z');
const minted = { token: 'minted', expiresAt: new Date(NOW.getTime() + 60 * 60_000) };

describe('GitTokenBroker job purposes', () => {
  const github = { mintInstallationToken: vi.fn(), mintReadOnlyToken: vi.fn(), mintReviewToken: vi.fn(), isBranchProtected: vi.fn() };
  /** US-003: the GitLab write mint reads the repo's own credential record. */
  const credentials = { resolve: vi.fn(), call: vi.fn() };
  const checker = { getBranchPushState: vi.fn() };
  let broker: GitTokenBroker;

  beforeEach(() => {
    vi.resetAllMocks();
    github.mintInstallationToken.mockResolvedValue(minted);
    github.mintReadOnlyToken.mockResolvedValue({ token: 'readonly', expiresAt: minted.expiresAt });
    github.mintReviewToken.mockResolvedValue({ token: 'review', expiresAt: minted.expiresAt });
    github.isBranchProtected.mockResolvedValue(true);
    credentials.resolve.mockResolvedValue({ token: 'gl-write', target: { apiBase: 'https://gitlab.com/api/v4', projectId: 1 } });
    credentials.call.mockImplementation(async (_repo, _kind, fn) => fn({ token: 'gl-write', target: { apiBase: 'https://gitlab.com/api/v4', projectId: 1 } }));
    checker.getBranchPushState.mockResolvedValue({ protected: true, canPush: false });
    broker = new GitTokenBroker({ gitTokenReuseMarginSec: 300, gitlabTokenTtlSec: 3600 }, github as never, credentials as never, checker as never);
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

  it('a repo with fixAllowUnprotected mints FIX write credentials without the protection check', async () => {
    github.isBranchProtected.mockResolvedValue(false);
    const result = await broker.mint({ jobId: 'j1', leaseEpoch: 1, repo: { ...repo, fixAllowUnprotected: true }, purpose: 'fix' }, NOW);
    expect(github.isBranchProtected).not.toHaveBeenCalled();
    expect(github.mintReadOnlyToken).not.toHaveBeenCalled();
    expect(github.mintInstallationToken).toHaveBeenCalledExactlyOnceWith(repo.githubInstallationId, repo.name);
    expect(result).toEqual({ ok: true, token: { jobId: 'j1', token: 'minted', username: 'x-access-token', expiresAt: minted.expiresAt.toISOString() } });
  });

  it('fixAllowUnprotected false still refuses an unprotected default branch', async () => {
    github.isBranchProtected.mockResolvedValue(false);
    await expect(broker.mint({ jobId: 'j1', leaseEpoch: 1, repo: { ...repo, fixAllowUnprotected: false }, purpose: 'fix' }, NOW)).resolves.toEqual({
      ok: false, error: { jobId: 'j1', reason: 'default_branch_unprotected' },
    });
    expect(github.mintInstallationToken).not.toHaveBeenCalled();
  });

  it('fixAllowUnprotected does not change a REVIEW mint', async () => {
    const result = await broker.mint({ jobId: 'j1', leaseEpoch: 1, repo: { ...repo, fixAllowUnprotected: true }, purpose: 'review' }, NOW);
    expect(github.mintReviewToken).toHaveBeenCalledTimes(1);
    expect(github.mintInstallationToken).not.toHaveBeenCalled();
    expect(result).toMatchObject({ ok: true, token: { token: 'review' } });
  });

  it('AC-9, AC-10: maps protection-check errors and never mints a write token', async () => {
    github.isBranchProtected.mockRejectedValue(new RepoCheckException('provider_error'));
    await expect(broker.mint({ jobId: 'j1', leaseEpoch: 1, repo, purpose: 'fix' }, NOW)).resolves.toEqual({
      ok: false, error: { jobId: 'j1', reason: 'provider_error' },
    });
    expect(github.mintInstallationToken).not.toHaveBeenCalled();
  });

  it('US-002 AC-1: GitLab review resolves the write token with oauth2 identity and TTL', async () => {
    await expect(broker.mint({ jobId: 'j1', leaseEpoch: 1, repo: gitlab, purpose: 'review' }, NOW)).resolves.toEqual({
      ok: true, token: { jobId: 'j1', token: 'gl-write', username: 'oauth2', expiresAt: '2026-10-01T01:00:00.000Z' },
    });
    expect(credentials.resolve).toHaveBeenCalledWith(gitlab, 'write');
  });

  it('US-002 AC-5: missing GitLab review credentials fail without a token or repoId', async () => {
    credentials.resolve.mockRejectedValue(new RepoCheckException('gitlab_credentials_missing'));
    await expect(broker.mint({ jobId: 'j1', leaseEpoch: 1, repo: gitlab, purpose: 'review' }, NOW)).resolves.toEqual({ ok: false, error: { jobId: 'j1', reason: 'gitlab_credentials_missing' } });
    expect(credentials.resolve).toHaveBeenCalledExactlyOnceWith(gitlab, 'write');
  });

  it('US-002 AC-2/3: read and readOnly GitLab grants use read token and differ on repoId', async () => {
    credentials.resolve.mockResolvedValueOnce({ token: 'gl-read' });
    await expect(broker.mint({ jobId: 'j1', leaseEpoch: 1, repo: gitlab, purpose: 'read' }, NOW)).resolves.toMatchObject({ ok: true, token: { token: 'gl-read' } });
    expect(credentials.resolve).toHaveBeenLastCalledWith(gitlab, 'read');
    credentials.resolve.mockResolvedValueOnce({ token: 'gl-read-only' });
    await expect(broker.mint({ jobId: 'j2', leaseEpoch: 1, repo: gitlab, readOnly: true }, NOW)).resolves.toMatchObject({ ok: true, token: { token: 'gl-read-only', repoId: 'r' } });
    expect(credentials.resolve).toHaveBeenLastCalledWith(gitlab, 'read');
  });

  it('US-002 AC-4: cached GitLab write cannot answer a read purpose', async () => {
    await broker.mint({ jobId: 'j1', leaseEpoch: 1, repo: gitlab }, NOW);
    credentials.resolve.mockResolvedValueOnce({ token: 'gl-read' });
    await expect(broker.mint({ jobId: 'j1', leaseEpoch: 1, repo: gitlab, purpose: 'read' }, NOW)).resolves.toMatchObject({ ok: true, token: { token: 'gl-read' } });
    expect(credentials.resolve).toHaveBeenNthCalledWith(2, gitlab, 'read');
  });

  it('US-002 AC-7/8: refuses both unprotected branches and protected branches the bot can push', async () => {
    for (const state of [{ protected: false, canPush: false }, { protected: true, canPush: true }]) {
      checker.getBranchPushState.mockResolvedValueOnce(state);
      await expect(broker.mint({ jobId: `j-${state.protected}`, leaseEpoch: 1, repo: gitlab, purpose: 'fix' }, NOW)).resolves.toMatchObject({ ok: false, error: { reason: 'default_branch_unprotected' } });
    }
    expect(credentials.resolve).not.toHaveBeenCalled();
  });

  it('US-002 AC-10/11/15: gate failures map reason and missing credentials stop before checker', async () => {
    credentials.call.mockRejectedValueOnce(new RepoCheckException('gitlab_token_invalid'));
    await expect(broker.mint({ jobId: 'invalid', leaseEpoch: 1, repo: gitlab, purpose: 'fix' }, NOW)).resolves.toMatchObject({ ok: false, error: { reason: 'gitlab_token_invalid' } });
    expect(credentials.resolve).not.toHaveBeenCalled();
    credentials.call.mockRejectedValueOnce(new RepoCheckException('gitlab_credentials_missing'));
    await expect(broker.mint({ jobId: 'missing', leaseEpoch: 1, repo: gitlab, purpose: 'fix' }, NOW)).resolves.toMatchObject({ ok: false, error: { reason: 'gitlab_credentials_missing' } });
    expect(checker.getBranchPushState).not.toHaveBeenCalled();
    expect(credentials.resolve).not.toHaveBeenCalled();
    checker.getBranchPushState.mockRejectedValueOnce(new RepoCheckException('provider_error'));
    await expect(broker.mint({ jobId: 'provider', leaseEpoch: 1, repo: gitlab, purpose: 'fix' }, NOW)).resolves.toMatchObject({ ok: false, error: { reason: 'provider_error' } });
    expect(credentials.resolve).not.toHaveBeenCalled();
  });

  it('US-002 AC-6 through AC-9/11: FIX gate checks bot push state before issuing write token', async () => {
    await expect(broker.mint({ jobId: 'j1', leaseEpoch: 1, repo: gitlab, purpose: 'fix' }, NOW)).resolves.toMatchObject({ ok: true, token: { token: 'gl-write' } });
    expect(credentials.call).toHaveBeenCalledWith(gitlab, 'write', expect.any(Function));
    expect(checker.getBranchPushState).toHaveBeenCalledWith(expect.anything(), 'main');
    checker.getBranchPushState.mockResolvedValueOnce({ protected: false, canPush: true });
    credentials.resolve.mockClear();
    await expect(broker.mint({ jobId: 'j2', leaseEpoch: 1, repo: gitlab, purpose: 'fix' }, NOW)).resolves.toMatchObject({ ok: false, error: { reason: 'default_branch_unprotected' } });
    expect(credentials.resolve).not.toHaveBeenCalled();
    await expect(broker.mint({ jobId: 'j3', leaseEpoch: 1, repo: { ...gitlab, fixAllowUnprotected: true }, purpose: 'fix' }, NOW)).resolves.toMatchObject({ ok: true });
    expect(checker.getBranchPushState).toHaveBeenCalledTimes(2);
  });

  it('AC-4 through AC-8: fresh FIX bypasses and replaces the cache while normal FIX reuses it', async () => {
    const cachedExpiry = new Date(NOW.getTime() + 50 * 60_000);
    github.mintInstallationToken.mockResolvedValueOnce({ token: 'cached-fix', expiresAt: cachedExpiry })
      .mockResolvedValueOnce({ token: 'fresh-fix', expiresAt: minted.expiresAt });
    const request = { jobId: 'j1', leaseEpoch: 1, repo, purpose: 'fix' as const };
    const cached = await broker.mint(request, NOW);
    const reused = await broker.mint(request, NOW);
    expect(reused).toEqual(cached);
    expect(github.mintInstallationToken).toHaveBeenCalledTimes(1);
    const installationCallsBeforeReuse = github.mintInstallationToken.mock.calls.length;
    const readOnlyCallsBeforeReuse = github.mintReadOnlyToken.mock.calls.length;
    expect(await broker.mint(request, NOW)).toEqual(cached);
    expect(github.mintInstallationToken).toHaveBeenCalledTimes(installationCallsBeforeReuse);
    expect(github.mintReadOnlyToken).toHaveBeenCalledTimes(readOnlyCallsBeforeReuse);

    const fresh = await broker.mint({ ...request, fresh: true }, NOW);
    expect(github.mintInstallationToken).toHaveBeenCalledTimes(2);
    expect(fresh).toMatchObject({ ok: true, token: { token: 'fresh-fix' } });
    const afterFresh = await broker.mint(request, NOW);
    expect(afterFresh).toEqual(fresh);
    expect(github.mintInstallationToken).toHaveBeenCalledTimes(2);
  });

  it('AC-9: fresh REVIEW bypasses its cached review token', async () => {
    github.mintReviewToken.mockResolvedValueOnce({ token: 'cached-review', expiresAt: minted.expiresAt })
      .mockResolvedValueOnce({ token: 'fresh-review', expiresAt: minted.expiresAt });
    const request = { jobId: 'j1', leaseEpoch: 1, repo, purpose: 'review' as const };
    await broker.mint(request, NOW);
    const fresh = await broker.mint({ ...request, fresh: true }, NOW);
    expect(github.mintReviewToken).toHaveBeenCalledTimes(2);
    expect(fresh).toMatchObject({ ok: true, token: { token: 'fresh-review' } });
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

  /**
   * US-005: an AGENT job's credential. `purpose: 'read'` is GitHub-only, mints the read-only token, carries no
   * `repoId` (the runner matches it to the job's default token request), and lives under its own cache key so a
   * read mint can never answer a write request or vice versa.
   */
  describe('read purpose (US-005)', () => {
    const read = { jobId: 'j1', leaseEpoch: 1, repo, purpose: 'read' as const };

    it('AC-6: mints a GitHub read-only token and returns it without a repoId', async () => {
      const result = await broker.mint(read, NOW);
      expect(result).toEqual({ ok: true, token: { jobId: 'j1', token: 'readonly', username: 'x-access-token', expiresAt: minted.expiresAt.toISOString() } });
      expect(github.mintReadOnlyToken).toHaveBeenCalledExactlyOnceWith(repo.githubInstallationId, repo.name);
      expect(github.mintInstallationToken).not.toHaveBeenCalled();
      // A read mint is not a FIX mint: no branch-protection probe.
      expect(github.isBranchProtected).not.toHaveBeenCalled();
    });

    it('AC-7: returns the cached read token for the same job and lease epoch without minting again', async () => {
      const first = await broker.mint(read, NOW);
      const second = await broker.mint(read, new Date(NOW.getTime() + 60_000));
      expect(second).toEqual(first);
      expect(github.mintReadOnlyToken).toHaveBeenCalledTimes(1);
    });

    it('AC-7: fresh: true re-mints a read token instead of reusing it', async () => {
      await broker.mint(read, NOW);
      await broker.mint({ ...read, fresh: true }, NOW);
      expect(github.mintReadOnlyToken).toHaveBeenCalledTimes(2);
    });

    it('AC-8: a read mint and a purpose-less mint for the same job and epoch mint twice and stay distinct', async () => {
      const readToken = await broker.mint(read, NOW);
      const writeToken = await broker.mint({ jobId: 'j1', leaseEpoch: 1, repo }, NOW);
      expect(github.mintReadOnlyToken).toHaveBeenCalledTimes(1);
      expect(github.mintInstallationToken).toHaveBeenCalledTimes(1);
      expect(readToken).toMatchObject({ ok: true, token: { token: 'readonly' } });
      expect(writeToken).toMatchObject({ ok: true, token: { token: 'minted' } });
      expect(readToken).not.toEqual(writeToken);
      // Both entries survive: a second read reuses only the read one.
      expect(await broker.mint(read, NOW)).toEqual(readToken);
      expect(github.mintReadOnlyToken).toHaveBeenCalledTimes(1);
      expect(github.mintInstallationToken).toHaveBeenCalledTimes(1);
    });

    it('US-002 AC-5: missing read credentials return the fixed reason without a token', async () => {
      credentials.resolve.mockRejectedValue(new RepoCheckException('gitlab_credentials_missing'));
      await expect(broker.mint({ jobId: 'j1', leaseEpoch: 1, repo: gitlab, purpose: 'read' }, NOW)).resolves.toEqual({ ok: false, error: { jobId: 'j1', reason: 'gitlab_credentials_missing' } });
      expect(credentials.resolve).toHaveBeenCalledWith(gitlab, 'read');
      expect(github.mintReadOnlyToken).not.toHaveBeenCalled();
    });

    it('AC-9: never falls back to a stored GitLab credential already cached by a write mint', async () => {
      credentials.resolve.mockResolvedValue({ token: 'glpat-stored', target: { apiBase: 'https://gitlab.com/api/v4', projectId: 4711 } });
      const write = await broker.mint({ jobId: 'j1', leaseEpoch: 1, repo: gitlab }, NOW);
      expect(write).toMatchObject({ ok: true, token: { token: 'glpat-stored' } });
      credentials.resolve.mockResolvedValueOnce({ token: 'glpat-read', target: { apiBase: 'https://gitlab.com/api/v4', projectId: 4711 } });
      await expect(broker.mint({ jobId: 'j1', leaseEpoch: 1, repo: gitlab, purpose: 'read' }, NOW)).resolves.toMatchObject({ ok: true, token: { token: 'glpat-read' } });
      expect(credentials.resolve).toHaveBeenCalledTimes(2);
      expect(credentials.resolve).toHaveBeenLastCalledWith(gitlab, 'read');
    });
  });
});
