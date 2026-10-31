import type { FleetRepoRecord } from '../repos/domain/fleet-repo.domain';
import type { IFleetPrReviewRepository } from './domain/fleet-pr-review.domain';
import { EnablerGate } from './enabler-gate';

const repoRecord = (over: Partial<FleetRepoRecord> = {}): FleetRepoRecord => ({
  id: 'r1', projectId: 'p1', provider: 'github', owner: 'o', name: 'n', defaultBranch: 'main',
  githubInstallationId: 1n, createdById: 'creator', createdAt: new Date('2026-11-01T00:00:00.000Z'),
  autoReview: true, autoReviewProfiles: [], autoReviewMaxCostUsd: '1.0000',
  autoReviewEnabledById: 'u1', autoReviewEnabledByType: 'USER', autoReviewEnabledAt: new Date('2026-11-01T00:00:00.000Z'),
  ...over,
});

function setup(options: {
  repo?: FleetRepoRecord;
  access?: { exists: boolean; disabled: boolean };
  keys?: ReadonlySet<string>;
} = {}) {
  const repo = options.repo ?? repoRecord();
  const reviews = {
    findPrincipalAccess: vi.fn().mockResolvedValue(options.access ?? { exists: true, disabled: false }),
  } as unknown as IFleetPrReviewRepository;
  const permissions = { effectiveKeys: vi.fn().mockResolvedValue(options.keys ?? new Set(['fleet.job.dispatch'])) };
  const repos = { disableAutoReview: vi.fn().mockResolvedValue(true) };
  return { gate: new EnablerGate(reviews, permissions as never, repos as never), repo, reviews, permissions, repos };
}

describe('EnablerGate.check', () => {
  it('AC-1: returns the stored USER enabler when it still has dispatch access', async () => {
    const { gate, repo } = setup();
    await expect(gate.check(repo)).resolves.toEqual({ type: 'USER', id: 'u1' });
  });

  it("AC-2: evaluates effective keys in the repo's project", async () => {
    const { gate, repo, permissions } = setup();
    await gate.check(repo);
    expect(permissions.effectiveKeys).toHaveBeenCalledWith({ type: 'USER', id: 'u1' }, { projectId: 'p1' });
  });

  it('AC-3: returns the stored AGENT enabler when it still has dispatch access', async () => {
    const { gate, repo } = setup({ repo: repoRecord({ autoReviewEnabledByType: 'AGENT', autoReviewEnabledById: 'a1' }) });
    await expect(gate.check(repo)).resolves.toEqual({ type: 'AGENT', id: 'a1' });
  });

  it('AC-4: returns null when dispatch permission is no longer held', async () => {
    const { gate, repo } = setup({ keys: new Set() });
    await expect(gate.check(repo)).resolves.toBeNull();
  });

  it("AC-5: disables auto-review with the repo and stored enabler ids when permission is lost", async () => {
    const { gate, repo, repos } = setup({ keys: new Set() });
    await gate.check(repo);
    expect(repos.disableAutoReview).toHaveBeenCalledWith('r1', 'enabler_lost_access', 'u1');
  });

  it('AC-6: disables auto-review when the stored USER is disabled', async () => {
    const { gate, repo, repos } = setup({ access: { exists: true, disabled: true } });
    await expect(gate.check(repo)).resolves.toBeNull();
    expect(repos.disableAutoReview).toHaveBeenCalledWith('r1', 'enabler_lost_access', 'u1');
  });

  it('AC-7: disables auto-review when the stored principal no longer exists', async () => {
    const { gate, repo, repos } = setup({ access: { exists: false, disabled: false } });
    await expect(gate.check(repo)).resolves.toBeNull();
    expect(repos.disableAutoReview).toHaveBeenCalledWith('r1', 'enabler_lost_access', 'u1');
  });

  it('awaits failed-access disable and returns null even when its compare-and-set loses', async () => {
    const { gate, repo, repos } = setup({ keys: new Set() });
    repos.disableAutoReview.mockResolvedValue(false);
    await expect(gate.check(repo)).resolves.toBeNull();
    expect(repos.disableAutoReview).toHaveBeenCalledTimes(1);
  });

  it('propagates access read failures', async () => {
    const { gate, repo, reviews } = setup();
    vi.mocked(reviews.findPrincipalAccess).mockRejectedValue(new Error('read failed'));
    await expect(gate.check(repo)).rejects.toThrow('read failed');
  });

  it('returns null when the repo has no stored enabler', async () => {
    const { gate, repo, reviews, permissions, repos } = setup({
      repo: repoRecord({ autoReviewEnabledById: null, autoReviewEnabledByType: null }),
    });
    await expect(gate.check(repo)).resolves.toBeNull();
    expect(reviews.findPrincipalAccess).not.toHaveBeenCalled();
    expect(permissions.effectiveKeys).not.toHaveBeenCalled();
    expect(repos.disableAutoReview).not.toHaveBeenCalled();
  });
});
