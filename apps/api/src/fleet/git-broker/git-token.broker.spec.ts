import { GitTokenBroker } from './git-token.broker';
import { RepoCheckException } from './repo-check.exception';
import type { FleetRepoRef } from '../jobs/domain/fleet-job.domain';

const github: FleetRepoRef = { id: 'r', projectId: 'p', provider: 'github', owner: 'acme', name: 'app', defaultBranch: 'main', githubInstallationId: BigInt(77) };
const gitlab: FleetRepoRef = { ...github, provider: 'gitlab', githubInstallationId: null };
const NOW = new Date('2026-10-01T00:00:00.000Z');

describe('GitTokenBroker', () => {
  const app = { mintInstallationToken: vi.fn(), mintReadOnlyToken: vi.fn() };
  const lab = { resolve: vi.fn() };
  let broker: GitTokenBroker;
  beforeEach(() => {
    vi.resetAllMocks();
    broker = new GitTokenBroker(
      { gitTokenReuseMarginSec: 300, gitlabTokenTtlSec: 3_600 },
      app as never,
      lab as never,
    );
  });

  it('mints a GitHub installation token and reuses it until 5 minutes before expiry', async () => {
    app.mintInstallationToken.mockResolvedValue({ token: 'ghs_1', expiresAt: new Date(NOW.getTime() + 60 * 60_000) });
    const a = await broker.mint({ jobId: 'j', leaseEpoch: 1, repo: github }, NOW);
    const b = await broker.mint({ jobId: 'j', leaseEpoch: 1, repo: github }, new Date(NOW.getTime() + 54 * 60_000));
    expect(a).toEqual({ ok: true, token: { jobId: 'j', token: 'ghs_1', username: 'x-access-token', expiresAt: '2026-10-01T01:00:00.000Z' } });
    expect(b).toEqual(a);
    expect(app.mintInstallationToken).toHaveBeenCalledTimes(1);
    await broker.mint({ jobId: 'j', leaseEpoch: 1, repo: github }, new Date(NOW.getTime() + 56 * 60_000));
    expect(app.mintInstallationToken).toHaveBeenCalledTimes(2);
    expect(app.mintInstallationToken).toHaveBeenCalledWith(BigInt(77), 'app');
  });

  it('never serves one epoch a token cached for another, and evicts a job', async () => {
    app.mintInstallationToken.mockResolvedValue({ token: 'ghs_1', expiresAt: new Date(NOW.getTime() + 60 * 60_000) });
    await broker.mint({ jobId: 'j', leaseEpoch: 1, repo: github }, NOW);
    await broker.mint({ jobId: 'j', leaseEpoch: 2, repo: github }, NOW);
    broker.evict('j');
    await broker.mint({ jobId: 'j', leaseEpoch: 2, repo: github }, NOW);
    expect(app.mintInstallationToken).toHaveBeenCalledTimes(3);
  });

  it('serves the stored GitLab token as oauth2 with a nominal one-hour expiry', async () => {
    lab.resolve.mockResolvedValue('glpat-1');
    await expect(broker.mint({ jobId: 'j', leaseEpoch: 1, repo: gitlab }, NOW)).resolves.toEqual({
      ok: true, token: { jobId: 'j', token: 'glpat-1', username: 'oauth2', expiresAt: '2026-10-01T01:00:00.000Z' },
    });
    expect(lab.resolve).toHaveBeenCalledWith('p', 'acme', 'app');
  });

  it('turns failures into fixed reasons and never echoes a token', async () => {
    app.mintInstallationToken.mockRejectedValue(new RepoCheckException('app_not_installed'));
    await expect(broker.mint({ jobId: 'j', leaseEpoch: 1, repo: github }, NOW)).resolves.toEqual({ ok: false, error: { jobId: 'j', reason: 'app_not_installed' } });
    app.mintInstallationToken.mockRejectedValue(new Error('boom ghs_secret'));
    const res = await broker.mint({ jobId: 'j', leaseEpoch: 1, repo: github }, NOW);
    expect(res).toEqual({ ok: false, error: { jobId: 'j', reason: 'provider_error' } });
    await expect(broker.mint({ jobId: 'j', leaseEpoch: 1, repo: { ...github, githubInstallationId: null } }, NOW))
      .resolves.toEqual({ ok: false, error: { jobId: 'j', reason: 'app_not_installed' } });
  });

  describe('read-only mint (fleet S5b US-001 AC7-AC13)', () => {
    const r1: FleetRepoRef = { ...github, id: 'r1', name: 'sandbox', githubInstallationId: BigInt(7) };
    const r2: FleetRepoRef = { ...github, id: 'r2', name: 'other', githubInstallationId: BigInt(7) };
    const hourAhead = new Date(NOW.getTime() + 60 * 60_000);

    beforeEach(() => {
      app.mintReadOnlyToken.mockResolvedValue({ token: 'ghs_ro', expiresAt: hourAhead });
      app.mintInstallationToken.mockResolvedValue({ token: 'ghs_rw', expiresAt: hourAhead });
    });

    it('US-001 AC7: mints through mintReadOnlyToken and resolves a token with the job and repo id', async () => {
      const res = await broker.mint({ jobId: 'j1', leaseEpoch: 2, repo: r1, readOnly: true }, NOW);
      expect(res).toEqual({ ok: true, token: { jobId: 'j1', repoId: 'r1', token: 'ghs_ro', username: 'x-access-token', expiresAt: '2026-10-01T01:00:00.000Z' } });
      expect(app.mintReadOnlyToken).toHaveBeenCalledWith(BigInt(7), 'sandbox');
      expect(app.mintInstallationToken).not.toHaveBeenCalled();
    });

    it('US-001 AC8: a write mint for the same job and epoch does not reuse the read-only entry', async () => {
      const readOnly = await broker.mint({ jobId: 'j1', leaseEpoch: 2, repo: r1, readOnly: true }, NOW);
      const write = await broker.mint({ jobId: 'j1', leaseEpoch: 2, repo: r1 }, NOW);
      expect(readOnly).toMatchObject({ ok: true, token: { repoId: 'r1', token: 'ghs_ro' } });
      expect(write).toEqual({ ok: true, token: { jobId: 'j1', token: 'ghs_rw', username: 'x-access-token', expiresAt: '2026-10-01T01:00:00.000Z' } });
      expect(app.mintReadOnlyToken).toHaveBeenCalledTimes(1);
      expect(app.mintInstallationToken).toHaveBeenCalledTimes(1);
    });

    it('US-001 AC9: a second read-only mint within the reuse margin calls no GitHub method', async () => {
      const first = await broker.mint({ jobId: 'j1', leaseEpoch: 2, repo: r1, readOnly: true }, NOW);
      const second = await broker.mint({ jobId: 'j1', leaseEpoch: 2, repo: r1, readOnly: true }, new Date(NOW.getTime() + 54 * 60_000));
      expect(second).toEqual(first);
      expect(app.mintReadOnlyToken).toHaveBeenCalledTimes(1);
      expect(app.mintInstallationToken).not.toHaveBeenCalled();
    });

    it('US-001 AC10: a read-only mint without an installation fails app_not_installed and calls no GitHub method', async () => {
      const repo: FleetRepoRef = { ...r1, githubInstallationId: null };
      await expect(broker.mint({ jobId: 'j1', leaseEpoch: 2, repo, readOnly: true }, NOW))
        .resolves.toEqual({ ok: false, error: { jobId: 'j1', repoId: 'r1', reason: 'app_not_installed' } });
      expect(app.mintReadOnlyToken).not.toHaveBeenCalled();
      expect(app.mintInstallationToken).not.toHaveBeenCalled();
      expect(lab.resolve).not.toHaveBeenCalled();
    });

    it('US-001 AC11: a read-only mint for a GitLab repository fails provider_error without any provider call', async () => {
      await expect(broker.mint({ jobId: 'j1', leaseEpoch: 2, repo: gitlab, readOnly: true }, NOW))
        .resolves.toEqual({ ok: false, error: { jobId: 'j1', repoId: 'r', reason: 'provider_error' } });
      expect(app.mintReadOnlyToken).not.toHaveBeenCalled();
      expect(app.mintInstallationToken).not.toHaveBeenCalled();
      expect(lab.resolve).not.toHaveBeenCalled();
    });

    it('US-001 AC12: evict drops the read-only and the write entry of the job', async () => {
      await broker.mint({ jobId: 'j1', leaseEpoch: 2, repo: r1, readOnly: true }, NOW);
      await broker.mint({ jobId: 'j1', leaseEpoch: 2, repo: r1 }, NOW);
      broker.evict('j1');
      await broker.mint({ jobId: 'j1', leaseEpoch: 2, repo: r1, readOnly: true }, NOW);
      await broker.mint({ jobId: 'j1', leaseEpoch: 2, repo: r1 }, NOW);
      expect(app.mintReadOnlyToken).toHaveBeenCalledTimes(2);
      expect(app.mintInstallationToken).toHaveBeenCalledTimes(2);
    });

    it('US-001 AC13: two repositories of the same job and epoch mint separately and keep their own repo id', async () => {
      const one = await broker.mint({ jobId: 'j1', leaseEpoch: 2, repo: r1, readOnly: true }, NOW);
      const two = await broker.mint({ jobId: 'j1', leaseEpoch: 2, repo: r2, readOnly: true }, NOW);
      expect(app.mintReadOnlyToken).toHaveBeenCalledTimes(2);
      expect(app.mintReadOnlyToken).toHaveBeenNthCalledWith(1, BigInt(7), 'sandbox');
      expect(app.mintReadOnlyToken).toHaveBeenNthCalledWith(2, BigInt(7), 'other');
      expect(one).toMatchObject({ ok: true, token: { jobId: 'j1', repoId: 'r1' } });
      expect(two).toMatchObject({ ok: true, token: { jobId: 'j1', repoId: 'r2' } });
    });
  });
});
