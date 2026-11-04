import { FleetPrRulingsService } from './fleet-pr-rulings.service';
import { GitHubAppClient } from '../git-broker/github-app-client';

const headSha = 'a'.repeat(40);
const repoRef = { id: 'repo', owner: 'acme', name: 'app', githubInstallationId: 42n };
const at = new Date('2026-11-01T00:00:00Z');
function setup() {
  const repo = {
    latestRunForPr: vi.fn(async () => 'latest'),
    pendingForFix: vi.fn(async () => [
      { id: 'r1', itemId: 'D-1', text: 'confirmed: evidence', actorType: 'AGENT', actorName: 'rev-bot', createdAt: at },
      { id: 'r2', itemId: 'B3', text: 'waived: scope', actorType: 'USER', actorName: `A\n${'x'.repeat(120)}`, createdAt: at },
    ]),
  };
  const github = { mintThreadReadToken: vi.fn(async () => ({ token: 'ephemeral' })), getPullRequest: vi.fn(async (): Promise<unknown> => ({ state: 'open', headSha })) };
  const service = new FleetPrRulingsService(repo as never, {} as never, {} as never, {} as never, github as never);
  return { service, repo, github };
}

describe('FIX ruling snapshot', () => {
  it('AC-2/3/7/8 selects only the latest RUN, maps both actors and sanitizes labels', async () => {
    const { service, repo, github } = setup();
    const result = await service.snapshotForFix(repoRef as never, 42);
    expect(repo.latestRunForPr).toHaveBeenCalledWith('repo', 42);
    expect(repo.pendingForFix).toHaveBeenCalledExactlyOnceWith('latest');
    expect(result).toEqual({ headSha, rulings: [
      { rulingId: 'r1', item: 'D-1', ruling: 'confirmed: evidence', by: 'koda:agent:rev-bot', at: at.toISOString() },
      { rulingId: 'r2', item: 'B3', ruling: 'waived: scope', by: `koda:user:A${'x'.repeat(89)}`, at: at.toISOString() },
    ] });
    expect(github.mintThreadReadToken).toHaveBeenCalledExactlyOnceWith(42n, 'app');
    expect(github.getPullRequest).toHaveBeenCalledExactlyOnceWith('ephemeral', 'acme', 'app', 42);
  });
  it('caps the snapshot at the oldest 100 even if a repository returns more', async () => {
    const { service, repo } = setup();
    repo.pendingForFix.mockResolvedValue(Array.from({ length: 101 }, (_, i) => ({ id: `r${i}`, itemId: `D-${i}`, text: 'verified', actorType: 'AGENT', actorName: 'rev-bot', createdAt: new Date((100 - i) * 1000) })));
    const result = await service.snapshotForFix(repoRef as never, 42);
    expect(result && 'rulings' in result && result.rulings.map((r) => r.item)).toEqual(Array.from({ length: 100 }, (_, i) => `D-${100 - i}`));
  });
  it('AC-4 does not read GitHub when none are pending', async () => {
    const { service, repo, github } = setup(); repo.pendingForFix.mockResolvedValue([]);
    expect(await service.snapshotForFix(repoRef as never, 42)).toBeUndefined();
    expect(github.mintThreadReadToken).not.toHaveBeenCalled();
  });
  it('no RUN means no snapshot', async () => {
    const { service, repo } = setup(); repo.latestRunForPr.mockResolvedValue(null as never);
    expect(await service.snapshotForFix(repoRef as never, 42)).toBeUndefined();
    expect(repo.pendingForFix).not.toHaveBeenCalled();
  });
  it('AC-5 thrown reads are accepted as unreadable', async () => {
    const { service, github } = setup(); github.getPullRequest.mockRejectedValue(new Error('provider failure'));
    expect(await service.snapshotForFix(repoRef as never, 42)).toEqual({ notSent: 'head-unreadable' });
  });
  it.each([{ state: 'closed', headSha }, null])('AC-6/14 closed or missing PR: %j', async (pr) => {
    const { service, github } = setup(); github.getPullRequest.mockResolvedValue(pr);
    expect(await service.snapshotForFix(repoRef as never, 42)).toEqual({ notSent: 'pr-not-open' });
  });
  it('an open PR without its head is unreadable', async () => {
    const { service, github } = setup(); github.getPullRequest.mockResolvedValue({ state: 'open' });
    expect(await service.snapshotForFix(repoRef as never, 42)).toEqual({ notSent: 'head-unreadable' });
  });
});

it('AC-1 GitHub getPullRequest maps head.sha without a socket', async () => {
  const http = { request: vi.fn(async () => ({ status: 200, body: { state: 'open', html_url: 'https://github.com/acme/app/pull/42', head: { sha: headSha } } })) };
  const client = new GitHubAppClient({} as never, { githubApiUrl: 'https://api.github.com' } as never, http as never, {} as never);
  expect(await client.getPullRequest('ephemeral', 'acme', 'app', 42)).toMatchObject({ headSha });
});
