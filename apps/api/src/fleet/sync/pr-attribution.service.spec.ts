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
import { currentAuditScope, currentBookkeepingReason, runInAuditScope } from '../../action-context/audit-coverage';

describe('PrAttributionService on a config job PR (fleet S3 §5 step 8: attribution replaces a PR body footer)', () => {
  it('posts "Dispatched by <name> via koda job <id>" for a terminal CONFIG_EDIT with a PR on its own repo', async () => {
    const repo = {
      findById: vi.fn(async () => ({ id: 'job-9', state: 'COMPLETED', command: 'CONFIG_EDIT', resultPrUrl: 'https://github.com/acme/app/pull/12', repoId: 'repo-1', leaseEpoch: 1, requestedById: 'u1' })),
      findRepo: vi.fn(async () => ({ id: 'repo-1', projectId: 'p1', provider: 'github', owner: 'acme', name: 'app', defaultBranch: 'main', githubInstallationId: BigInt(77) })),
      claimAttribution: vi.fn(async () => true),
      findUserDisplayName: vi.fn(async () => 'Dev One'),
    };
    const github = { commentOnPullRequest: vi.fn(async () => true) };
    const svc = new PrAttributionService(repo as never, github as never, {} as never, {} as never);
    await expect(svc.attribute('job-9')).resolves.toBe('posted');
    expect(github.commentOnPullRequest).toHaveBeenCalledWith(BigInt(77), 'acme', 'app', 12, 'Dispatched by Dev One via koda job job-9', expect.objectContaining({ jobId: 'job-9' }));
  });
});

describe('PrAttributionService audit coverage (permissions P2 US-006)', () => {
  it('AC-1/AC-2: claims attribution in its detached scope under the claim bookkeeping reason', async () => {
    let observedReason: ReturnType<typeof currentBookkeepingReason>;
    let observedSurface: string | undefined;
    let observedParent: ReturnType<typeof currentAuditScope>;
    const repo = {
      findById: vi.fn(async () => ({ id: 'j1', state: 'COMPLETED', resultPrUrl: 'https://github.com/acme/app/pull/12', repoId: 'r1', leaseEpoch: 1, requestedById: 'u1', requestedByType: 'USER' })),
      findRepo: vi.fn(async () => ({ id: 'r1', projectId: 'p1', provider: 'github', owner: 'acme', name: 'app', githubInstallationId: BigInt(77) })),
      claimAttribution: vi.fn(async () => {
        observedReason = currentBookkeepingReason();
        observedSurface = currentAuditScope()?.surface;
        observedParent = currentAuditScope()?.parent;
        return false;
      }),
    };
    const svc = new PrAttributionService(repo as never, {} as never, {} as never, {} as never);

    await runInAuditScope('POST /fleet/runner/sync', () => svc.attribute('j1'));
    expect(repo.claimAttribution).toHaveBeenCalledWith('j1', expect.any(Date));
    expect(observedReason).toBe('fleet.pr-attribution-claim');
    expect(observedSurface).toBe('task:PrAttributionService.attribute');
    expect(observedParent).toBeUndefined();
  });
});

describe('PrAttributionService names an agent requester (permissions P1d US-002)', () => {
  const job = (over: Record<string, unknown> = {}) => ({
    id: 'job-9', state: 'COMPLETED', command: 'RUN', resultPrUrl: 'https://github.com/acme/app/pull/12', repoId: 'repo-1', leaseEpoch: 1,
    requestedById: 'a1', requestedByType: 'AGENT', ...over,
  });
  const repoOf = (over: Record<string, unknown> = {}) => ({
    findById: vi.fn(async () => job(over)),
    findRepo: vi.fn(async () => ({ id: 'repo-1', projectId: 'p1', provider: 'github', owner: 'acme', name: 'app', defaultBranch: 'main', githubInstallationId: BigInt(77) })),
    claimAttribution: vi.fn(async () => true),
    findAgentDisplayName: vi.fn(async () => 'Builder'),
    findUserDisplayName: vi.fn(async () => 'Dev One'),
  });

  it('AC-7 posts the agent name for a job the agent requested', async () => {
    const repo = repoOf();
    const github = { commentOnPullRequest: vi.fn(async () => true) };
    const svc = new PrAttributionService(repo as never, github as never, {} as never, {} as never);

    await expect(svc.attribute('job-9')).resolves.toBe('posted');
    expect(repo.findAgentDisplayName).toHaveBeenCalledWith('a1');
    expect(github.commentOnPullRequest).toHaveBeenCalledWith(
      BigInt(77), 'acme', 'app', 12, 'Dispatched by Builder via koda job job-9', expect.objectContaining({ jobId: 'job-9' }),
    );
  });

  it('AC-8 never looks up a user for a job the agent requested', async () => {
    const repo = repoOf();
    const svc = new PrAttributionService(repo as never, { commentOnPullRequest: vi.fn(async () => true) } as never, {} as never, {} as never);

    await svc.attribute('job-9');
    expect(repo.findUserDisplayName).not.toHaveBeenCalled();
  });

  it('AC-9 falls back to "a koda agent" when the requesting agent is gone', async () => {
    const repo = repoOf({ requestedById: 'gone' });
    repo.findAgentDisplayName.mockResolvedValueOnce(null);
    const github = { commentOnPullRequest: vi.fn(async () => true) };
    const svc = new PrAttributionService(repo as never, github as never, {} as never, {} as never);

    await expect(svc.attribute('job-9')).resolves.toBe('posted');
    expect(github.commentOnPullRequest).toHaveBeenCalledWith(
      BigInt(77), 'acme', 'app', 12, 'Dispatched by a koda agent via koda job job-9', expect.objectContaining({ jobId: 'job-9' }),
    );
  });

  it('keeps the user path: a user-requested job still names the user, and "a koda user" when it is gone', async () => {
    const repo = repoOf({ requestedById: 'u1', requestedByType: 'USER' });
    const github = { commentOnPullRequest: vi.fn(async () => true) };
    const svc = new PrAttributionService(repo as never, github as never, {} as never, {} as never);

    await svc.attribute('job-9');
    expect(repo.findAgentDisplayName).not.toHaveBeenCalled();
    expect(github.commentOnPullRequest).toHaveBeenCalledWith(BigInt(77), 'acme', 'app', 12, 'Dispatched by Dev One via koda job job-9', expect.anything());

    repo.findUserDisplayName.mockResolvedValueOnce(null);
    await svc.attribute('job-9');
    expect(github.commentOnPullRequest).toHaveBeenLastCalledWith(BigInt(77), 'acme', 'app', 12, 'Dispatched by a koda user via koda job job-9', expect.anything());
  });
});
