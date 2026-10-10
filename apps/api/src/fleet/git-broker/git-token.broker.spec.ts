import { GitTokenBroker } from './git-token.broker';
import { RepoCheckException } from './repo-check.exception';
import type { FleetRepoRef } from '../jobs/domain/fleet-job.domain';

const github: FleetRepoRef = { id: 'r', projectId: 'p', provider: 'github', owner: 'acme', name: 'app', defaultBranch: 'main', githubInstallationId: BigInt(77) };
const gitlab: FleetRepoRef = { ...github, provider: 'gitlab', githubInstallationId: null };
const NOW = new Date('2026-10-01T00:00:00.000Z');

describe('GitTokenBroker', () => {
  const app = { mintInstallationToken: vi.fn() };
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
});
