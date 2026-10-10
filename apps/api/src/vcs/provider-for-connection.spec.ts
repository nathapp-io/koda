import type { Mock } from 'vitest';
import { branchWebUrl, providerForConnection, repoWebUrl } from './provider-for-connection';
import { parseRepoPath, HttpClient } from './factory';

function recordingClient(data: unknown = { default_branch: 'main' }): HttpClient & { get: Mock } {
  return { get: vi.fn().mockResolvedValue({ data }), post: vi.fn() } as HttpClient & { get: Mock };
}

describe('repoWebUrl / branchWebUrl (BUG-14)', () => {
  it.each([
    [{ provider: 'github', repoOwner: 'o', repoName: 'r' }, {}, 'https://github.com/o/r'],
    [{ provider: 'github', repoOwner: 'o', repoName: 'r' }, { githubApiUrl: 'https://api.github.com/' }, 'https://github.com/o/r'],
    [{ provider: 'github', repoOwner: 'o', repoName: 'r' }, { githubApiUrl: 'https://ghe.corp/api/v3' }, 'https://ghe.corp/o/r'],
    [{ provider: 'gitlab', repoOwner: 'grp/sub', repoName: 'r' }, {}, 'https://gitlab.com/grp/sub/r'],
    [{ provider: 'gitlab', repoOwner: 'grp', repoName: 'r' }, { gitlabApiUrl: 'https://git.corp/api/v4/' }, 'https://git.corp/grp/r'],
  ])('%j with %j → %s', (target, urls, expected) => {
    expect(repoWebUrl(target, urls)).toBe(expected);
  });

  it('uses the provider branch route', () => {
    expect(branchWebUrl({ provider: 'github', repoOwner: 'o', repoName: 'r' }, 'feat/x')).toBe('https://github.com/o/r/tree/feat/x');
    expect(branchWebUrl({ provider: 'gitlab', repoOwner: 'g', repoName: 'r' }, 'feat/x')).toBe('https://gitlab.com/g/r/-/tree/feat/x');
  });
});

describe('providerForConnection (BUG-14)', () => {
  it('builds a self-hosted GitLab provider against the configured API base', async () => {
    const http = recordingClient();
    const provider = providerForConnection(
      { provider: 'gitlab', repoOwner: 'grp/sub', repoName: 'app' },
      'tok',
      { gitlabApiUrl: 'https://git.corp/api/v4' },
      http,
    );

    await provider.getDefaultBranch();

    expect(http.get.mock.calls[0][0]).toBe('https://git.corp/api/v4/projects/grp%2Fsub%2Fapp');
  });

  it('builds a GHES provider against the configured API base', async () => {
    const http = recordingClient();
    const provider = providerForConnection(
      { provider: 'github', repoOwner: 'o', repoName: 'r' },
      'tok',
      { githubApiUrl: 'https://ghe.corp/api/v3' },
      http,
    );

    await provider.getDefaultBranch();

    expect(http.get.mock.calls[0][0]).toBe('https://ghe.corp/api/v3/repos/o/r');
  });

  it('links GitLab commits on the self-hosted web host', async () => {
    const http = recordingClient([{ id: 'abc', message: 'm', author_name: 'a', author_email: 'e', authored_date: '2026-09-28T00:00:00Z' }]);
    const provider = providerForConnection(
      { provider: 'gitlab', repoOwner: 'grp', repoName: 'r' },
      'tok',
      { gitlabApiUrl: 'https://git.corp/api/v4' },
      http,
    );

    const [commit] = await provider.listPrCommits(3);

    expect(commit.url).toBe('https://git.corp/grp/r/-/commit/abc');
  });
});

describe('parseRepoPath', () => {
  it.each([
    ['github', 'https://github.com/o/r', { repoOwner: 'o', repoName: 'r' }],
    ['github', 'https://github.com/o/r.git', { repoOwner: 'o', repoName: 'r' }],
    ['github', 'github.com/o/r', { repoOwner: 'o', repoName: 'r' }],
    ['github', 'https://ghe.corp/o/r/tree/main', { repoOwner: 'o', repoName: 'r' }],
    ['gitlab', 'https://gitlab.com/a/b/c', { repoOwner: 'a/b', repoName: 'c' }],
    ['gitlab', 'https://git.corp/a/b/-/tree/main', { repoOwner: 'a', repoName: 'b' }],
    ['github', 'https://github.com/only', null],
    ['gitlab', 'https://gitlab.com/solo', null],
    ['github', 'not a url at all', null],
    ['github', undefined, null],
  ])('%s %s', (provider, url, expected) => {
    expect(parseRepoPath(provider, url)).toEqual(expected);
  });
});
