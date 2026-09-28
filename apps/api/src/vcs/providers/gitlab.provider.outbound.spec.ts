/**
 * BUG-14 outbound: auto-MR creation proceeds when the branch already exists.
 * GitLab reports that as HTTP 400 with {"message":"Branch already exists"},
 * which the default HTTP client must surface on the error.
 */
import { createVcsProvider } from '../factory';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('GitLabProvider.createPullRequest with the default HTTP client', () => {
  let fetchSpy: jest.SpyInstance;

  afterEach(() => fetchSpy.mockRestore());

  it('creates the MR when the branch already exists', async () => {
    fetchSpy = jest.spyOn(global, 'fetch')
      .mockResolvedValueOnce(jsonResponse(200, { default_branch: 'main' }))
      .mockResolvedValueOnce(jsonResponse(400, { message: 'Branch already exists' }))
      .mockResolvedValueOnce(jsonResponse(201, { iid: 4, web_url: 'https://gitlab.com/g/r/-/merge_requests/4', state: 'opened', draft: true }));
    const provider = createVcsProvider('gitlab', { provider: 'gitlab', token: 't', repoUrl: 'https://gitlab.com/g/r' });

    const mr = await provider.createPullRequest({ title: 'T', body: 'B', branchName: 'feat' });

    expect(mr.number).toBe(4);
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });

  it('still fails on any other 400', async () => {
    fetchSpy = jest.spyOn(global, 'fetch')
      .mockResolvedValueOnce(jsonResponse(200, { default_branch: 'main' }))
      .mockResolvedValueOnce(jsonResponse(400, { message: 'Invalid branch name' }));
    const provider = createVcsProvider('gitlab', { provider: 'gitlab', token: 't', repoUrl: 'https://gitlab.com/g/r' });

    await expect(provider.createPullRequest({ title: 'T', body: 'B', branchName: 'bad..name' })).rejects.toThrow('HTTP 400');
  });
});
