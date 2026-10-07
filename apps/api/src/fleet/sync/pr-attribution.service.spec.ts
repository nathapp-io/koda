import { prNumberFor } from './pr-attribution.service';

describe('prNumberFor (plan D19)', () => {
  const gh = { provider: 'github' as const, owner: 'acme', name: 'app' };
  const gl = { provider: 'gitlab' as const, owner: 'acme/platform', name: 'api' };

  it.each([
    [gh, 'https://github.com/acme/app/pull/12', 12],
    [gh, 'https://github.com/Acme/App/pull/12/', 12],
    [gh, 'https://ghe.acme.io/acme/app/pull/3', 3],
    [gl, 'https://gitlab.com/acme/platform/api/-/merge_requests/7', 7],
  ])('%o %s -> %s', (repo, url, n) => {
    expect(prNumberFor(repo, url)).toBe(n);
  });

  it.each([
    [gh, 'https://github.com/evil/app/pull/12'],
    [gh, 'https://github.com/acme/app/issues/12'],
    [gh, 'not a url'],
    [gl, 'https://gitlab.com/acme/other/api/-/merge_requests/7'],
    [gh, 'https://github.com/acme/app/pull/12x'],
  ])('refuses %o %s', (repo, url) => {
    expect(prNumberFor(repo, url)).toBeNull();
  });
});

describe('prNumberFor hostile input', () => {
  it('returns null when a URL path segment is undecodable (%E0%A4%A) instead of throwing', () => {
    expect(prNumberFor({ provider: 'github', owner: 'acme', name: 'app' }, 'https://github.com/%E0%A4%A/app/pull/12')).toBeNull();
  });
  it('returns null for a GitLab MR with an undecodable path segment', () => {
    expect(prNumberFor({ provider: 'gitlab', owner: 'acme', name: 'app' }, 'https://gitlab.example.com/%E0%A4%A/app/-/merge_requests/12')).toBeNull();
  });
});

import { PrAttributionService } from './pr-attribution.service';

describe('PrAttributionService on a config job PR (fleet S3 §5 step 8: attribution replaces a PR body footer)', () => {
  it('posts "Dispatched by <name> via koda job <id>" for a terminal CONFIG_EDIT with a PR on its own repo', async () => {
    const repo = {
      findById: jest.fn(async () => ({ id: 'job-9', state: 'COMPLETED', command: 'CONFIG_EDIT', resultPrUrl: 'https://github.com/acme/app/pull/12', repoId: 'repo-1', leaseEpoch: 1, requestedById: 'u1' })),
      findRepo: jest.fn(async () => ({ id: 'repo-1', projectId: 'p1', provider: 'github', owner: 'acme', name: 'app', defaultBranch: 'main', githubInstallationId: BigInt(77) })),
      claimAttribution: jest.fn(async () => true),
      findUserDisplayName: jest.fn(async () => 'Dev One'),
    };
    const github = { commentOnPullRequest: jest.fn(async () => true) };
    const svc = new PrAttributionService(repo as never, github as never, {} as never, {} as never);
    await expect(svc.attribute('job-9')).resolves.toBe('posted');
    expect(github.commentOnPullRequest).toHaveBeenCalledWith(BigInt(77), 'acme', 'app', 12, 'Dispatched by Dev One via koda job job-9', expect.objectContaining({ jobId: 'job-9' }));
  });
});
