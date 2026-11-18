import { GitLabProvider } from './gitlab.provider';
import type { HttpClient } from '../factory';
import { MAX_MR_LOOKUP_PAGES } from './pagination';

describe('GitLabProvider.findOpenPullRequestByBranch', () => {
  const api = 'https://gitlab.example/api/v4';
  const get = vi.fn();
  const provider = new GitLabProvider('acme', 'app', 'token', { get, post: vi.fn() } as unknown as HttpClient, api);

  const fork = (iid: number) => ({
    iid, web_url: `https://gitlab.example/fork/mr/${iid}`, state: 'opened', draft: false, merged_at: null,
    merged_by: null, merge_commit_sha: null, title: 'Fork', source_branch: 'ACME-7-fix-login',
    source_project_id: 2, target_project_id: 1,
  });
  const sameProject = (iid: number) => ({
    iid, web_url: `https://gitlab.example/acme/app/-/merge_requests/${iid}`, state: 'opened', draft: false,
    merged_at: null, merged_by: null, merge_commit_sha: null, title: 'Same project',
    source_branch: 'ACME-7-fix-login', source_project_id: 1, target_project_id: 1,
  });

  beforeEach(() => get.mockReset());

  it('AC-4: requests opened merge requests for the source branch', async () => {
    get.mockResolvedValue({ data: [] });

    await provider.findOpenPullRequestByBranch('ACME-7-fix-login');

    expect(get).toHaveBeenCalledWith(`${api}/projects/acme%2Fapp/merge_requests`, {
      headers: { 'PRIVATE-TOKEN': 'token' },
      params: { state: 'opened', source_branch: 'ACME-7-fix-login', per_page: 100, page: 1 },
    });
  });

  it('AC-5: maps the first same-project merge request, skipping fork requests', async () => {
    get.mockResolvedValue({ data: [fork(70), sameProject(71), sameProject(72)] });

    await expect(provider.findOpenPullRequestByBranch('ACME-7-fix-login')).resolves.toMatchObject({
      number: 71, url: 'https://gitlab.example/acme/app/-/merge_requests/71',
    });
  });

  it.each([
    ['empty list', []],
    ['fork merge requests only', [fork(70)]],
  ])('AC-6: returns null for %s', async (_case, data) => {
    get.mockResolvedValue({ data });

    await expect(provider.findOpenPullRequestByBranch('ACME-7-fix-login')).resolves.toBeNull();
  });

  // Review B3: a page of fork requests is not proof that the branch has no same-project request.
  it('scans the next page when the first holds no same-project request', async () => {
    get
      .mockResolvedValueOnce({ data: [fork(70)], headers: { 'x-next-page': '2' } })
      .mockResolvedValueOnce({ data: [sameProject(71)], headers: { 'x-next-page': '' } });

    await expect(provider.findOpenPullRequestByBranch('ACME-7-fix-login')).resolves.toMatchObject({ number: 71 });
    expect(get).toHaveBeenCalledTimes(2);
    expect(get).toHaveBeenLastCalledWith(`${api}/projects/acme%2Fapp/merge_requests`, {
      headers: { 'PRIVATE-TOKEN': 'token' },
      params: { state: 'opened', source_branch: 'ACME-7-fix-login', per_page: 100, page: 2 },
    });
  });

  it.each([
    `<${api}/projects/acme%2Fapp/merge_requests?state=opened&page=2>; rel="next"`,
    '<?page=2>; rel="next"',
    '<https://other.example/unrelated?page=2>; rel="next"',
  ])('uses only the page number from the next Link %s', async (link) => {
    get
      .mockResolvedValueOnce({
        data: [fork(70)],
        headers: { link },
      })
      .mockResolvedValueOnce({ data: [sameProject(71)], headers: {} });

    await expect(provider.findOpenPullRequestByBranch('ACME-7-fix-login')).resolves.toMatchObject({ number: 71 });
    expect(get).toHaveBeenCalledTimes(2);
    expect(get).toHaveBeenLastCalledWith(`${api}/projects/acme%2Fapp/merge_requests`, {
      headers: { 'PRIVATE-TOKEN': 'token' },
      params: { state: 'opened', source_branch: 'ACME-7-fix-login', per_page: 100, page: 2 },
    });
  });

  it.each([
    { link: '<?after=cursor>; rel="next"' },
    { 'x-next-page': '2junk' },
  ])('rejects an advertised continuation it cannot follow: %j', async (headers) => {
    get.mockResolvedValueOnce({ data: [fork(70)], headers });

    await expect(provider.findOpenPullRequestByBranch('ACME-7-fix-login')).rejects.toThrow('Invalid next page');
    expect(get).toHaveBeenCalledTimes(1);
  });

  it('returns null only once every page has been scanned', async () => {
    get
      .mockResolvedValueOnce({ data: [fork(70)], headers: { 'x-next-page': '2' } })
      .mockResolvedValueOnce({ data: [fork(71)], headers: { 'x-next-page': '' } });

    await expect(provider.findOpenPullRequestByBranch('ACME-7-fix-login')).resolves.toBeNull();
    expect(get).toHaveBeenCalledTimes(2);
  });

  it('rejects instead of answering null when the scan reaches its page bound', async () => {
    get.mockResolvedValue({ data: [fork(70)], headers: { 'x-next-page': '2' } });

    await expect(provider.findOpenPullRequestByBranch('ACME-7-fix-login')).rejects.toThrow(
      `reached ${MAX_MR_LOOKUP_PAGES} pages`,
    );
    expect(get).toHaveBeenCalledTimes(MAX_MR_LOOKUP_PAGES);
  });
});
