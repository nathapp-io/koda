import { GitLabProvider } from './gitlab.provider';
import type { HttpClient } from '../factory';

describe('GitLabProvider.findOpenPullRequestByBranch', () => {
  const api = 'https://gitlab.example/api/v4';
  const get = vi.fn();
  const provider = new GitLabProvider('acme', 'app', 'token', { get, post: vi.fn() } as unknown as HttpClient, api);

  beforeEach(() => get.mockReset());

  it('AC-4: requests opened merge requests for the source branch', async () => {
    get.mockResolvedValue({ data: [] });

    await provider.findOpenPullRequestByBranch('ACME-7-fix-login');

    expect(get).toHaveBeenCalledWith(`${api}/projects/acme%2Fapp/merge_requests`, {
      headers: { 'PRIVATE-TOKEN': 'token' },
      params: { state: 'opened', source_branch: 'ACME-7-fix-login' },
    });
  });

  it('AC-5: maps the first same-project merge request, skipping fork requests', async () => {
    get.mockResolvedValue({ data: [
      { iid: 70, web_url: 'https://gitlab.example/fork/mr/70', state: 'opened', draft: false, merged_at: null, merged_by: null, merge_commit_sha: null, title: 'Fork', source_branch: 'ACME-7-fix-login', source_project_id: 2, target_project_id: 1 },
      { iid: 71, web_url: 'https://gitlab.example/acme/app/-/merge_requests/71', state: 'opened', draft: false, merged_at: null, merged_by: null, merge_commit_sha: null, title: 'First same project', source_branch: 'ACME-7-fix-login', source_project_id: 1, target_project_id: 1 },
      { iid: 72, web_url: 'https://gitlab.example/acme/app/-/merge_requests/72', state: 'opened', draft: false, merged_at: null, merged_by: null, merge_commit_sha: null, title: 'Second same project', source_branch: 'ACME-7-fix-login', source_project_id: 1, target_project_id: 1 },
    ] });

    await expect(provider.findOpenPullRequestByBranch('ACME-7-fix-login')).resolves.toMatchObject({
      number: 71, url: 'https://gitlab.example/acme/app/-/merge_requests/71',
    });
  });

  it.each([
    ['empty list', []],
    ['fork merge requests only', [{ iid: 70, web_url: 'https://gitlab.example/fork/mr/70', state: 'opened', draft: false, merged_at: null, merged_by: null, merge_commit_sha: null, title: 'Fork', source_branch: 'ACME-7-fix-login', source_project_id: 2, target_project_id: 1 }]],
  ])('AC-6: returns null for %s', async (_case, data) => {
    get.mockResolvedValue({ data });

    await expect(provider.findOpenPullRequestByBranch('ACME-7-fix-login')).resolves.toBeNull();
  });
});
