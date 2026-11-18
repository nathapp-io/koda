import { GitHubProvider } from './github.provider';
import type { HttpClient } from '../factory';

describe('GitHubProvider.findOpenPullRequestByBranch', () => {
  const api = 'https://ghe.example/api/v3';
  const get = vi.fn();
  const provider = new GitHubProvider('acme', 'app', 'token', { get, post: vi.fn() } as unknown as HttpClient, api);

  beforeEach(() => get.mockReset());

  it('AC-1: requests open pull requests for the owner and branch', async () => {
    get.mockResolvedValue({ data: [] });

    await provider.findOpenPullRequestByBranch('ACME-7-fix-login');

    expect(get).toHaveBeenCalledWith(`${api}/repos/acme/app/pulls`, {
      headers: { Authorization: 'Bearer token' },
      params: { state: 'open', head: 'acme:ACME-7-fix-login' },
    });
  });

  it('AC-2: maps the first matching pull request status', async () => {
    get.mockResolvedValue({ data: [{
      number: 7, state: 'open', draft: false, merged: false, merged_at: null,
      merged_by: null, merge_commit_sha: null, html_url: 'https://github.com/acme/app/pull/7',
      title: 'Fix login', head: { ref: 'ACME-7-fix-login', sha: 'abc' },
    }] });

    await expect(provider.findOpenPullRequestByBranch('ACME-7-fix-login')).resolves.toMatchObject({
      number: 7, url: 'https://github.com/acme/app/pull/7',
    });
  });

  it('AC-3: returns null when no open pull request exists', async () => {
    get.mockResolvedValue({ data: [] });

    await expect(provider.findOpenPullRequestByBranch('ACME-7-fix-login')).resolves.toBeNull();
  });
});
