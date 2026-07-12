/**
 * GitLab Provider Integration Tests
 *
 * Verifies that GitLabProvider correctly implements IVcsProvider interface
 * by making GitLab API (v4) calls with proper authentication, and response mapping.
 *
 * Run: DATABASE_URL=file:./koda-test.ephemeral.db npx jest test/integration/vcs/gitlab.provider.integration.spec.ts
 */

import { NotFoundAppException } from '@nathapp/nestjs-common';
import { GitLabProvider } from '../../../src/vcs/providers/gitlab.provider';
import { HttpClient } from '../../../src/vcs/factory';

describe('GitLabProvider (Integration)', () => {
  let provider: GitLabProvider;
  let mockHttpClient: jest.Mocked<HttpClient>;

  const testOwner = 'test-owner';
  const testRepo = 'test-repo';
  const testToken = 'test-token-123';
  const expectedProjectId = `${testOwner}%2F${testRepo}`;

  beforeEach(() => {
    mockHttpClient = {
      get: jest.fn(),
      post: jest.fn(),
    };

    provider = new GitLabProvider(testOwner, testRepo, testToken, mockHttpClient);
  });

  describe('fetchIssues', () => {
    it('should call GET /projects/:id/issues with correct parameters and PRIVATE-TOKEN header', async () => {
      mockHttpClient.get.mockResolvedValue({ data: [] });

      await provider.fetchIssues();

      expect(mockHttpClient.get).toHaveBeenCalledWith(
        `https://gitlab.com/api/v4/projects/${expectedProjectId}/issues`,
        expect.objectContaining({
          headers: expect.objectContaining({
            'PRIVATE-TOKEN': testToken,
          }),
          params: expect.objectContaining({
            state: 'opened',
          }),
        }),
      );
    });

    it('should return mapped VcsIssue array', async () => {
      mockHttpClient.get.mockResolvedValue({
        data: [
          {
            iid: 42,
            title: 'Test Issue',
            description: 'Test body',
            author: { username: 'testuser' },
            web_url: 'https://gitlab.com/test/repo/-/issues/42',
            labels: ['bug', 'feature'],
            created_at: '2024-01-01T00:00:00Z',
          },
        ],
      });

      const result = await provider.fetchIssues();

      expect(result).toEqual([
        {
          number: 42,
          title: 'Test Issue',
          body: 'Test body',
          authorLogin: 'testuser',
          url: 'https://gitlab.com/test/repo/-/issues/42',
          labels: ['bug', 'feature'],
          createdAt: new Date('2024-01-01T00:00:00Z'),
        },
      ]);
    });

    it('should pass created_after when since is provided', async () => {
      const sinceDate = new Date('2024-01-15T10:30:00Z');
      mockHttpClient.get.mockResolvedValue({ data: [] });

      await provider.fetchIssues(sinceDate);

      const callArgs = mockHttpClient.get.mock.calls[0];
      expect(callArgs[1].params.created_after).toBe(sinceDate.toISOString());
    });

    it('should handle null description', async () => {
      mockHttpClient.get.mockResolvedValue({
        data: [
          {
            iid: 1,
            title: 'No body',
            description: null,
            author: { username: 'user1' },
            web_url: 'https://gitlab.com/test/repo/-/issues/1',
            labels: [],
            created_at: '2024-01-01T00:00:00Z',
          },
        ],
      });

      const result = await provider.fetchIssues();

      expect(result[0].body).toBeNull();
    });
  });

  describe('fetchIssue', () => {
    it('should call GET /projects/:id/issues/:iid', async () => {
      mockHttpClient.get.mockResolvedValue({
        data: {
          iid: 42,
          title: 'Test Issue',
          description: 'Test body',
          author: { username: 'testuser' },
          web_url: 'https://gitlab.com/test/repo/-/issues/42',
          labels: [],
          created_at: '2024-01-01T00:00:00Z',
        },
      });

      await provider.fetchIssue(42);

      expect(mockHttpClient.get).toHaveBeenCalledWith(
        `https://gitlab.com/api/v4/projects/${expectedProjectId}/issues/42`,
        expect.objectContaining({
          headers: expect.objectContaining({ 'PRIVATE-TOKEN': testToken }),
        }),
      );
    });

    it('should throw NotFoundAppException on 404', async () => {
      const error: any = new Error('Not found');
      error.response = { status: 404 };
      mockHttpClient.get.mockRejectedValue(error);

      await expect(provider.fetchIssue(9999)).rejects.toThrow(NotFoundAppException);
    });

    it('should re-throw non-404 errors', async () => {
      mockHttpClient.get.mockRejectedValue(new Error('Network error'));

      await expect(provider.fetchIssue(1)).rejects.toThrow('Network error');
    });
  });

  describe('testConnection', () => {
    it('should call GET /projects/:id and return ok: true on success', async () => {
      mockHttpClient.get.mockResolvedValue({ data: { default_branch: 'main' } });

      const result = await provider.testConnection();

      expect(mockHttpClient.get).toHaveBeenCalledWith(
        `https://gitlab.com/api/v4/projects/${expectedProjectId}`,
        expect.objectContaining({
          headers: expect.objectContaining({ 'PRIVATE-TOKEN': testToken }),
        }),
      );
      expect(result).toEqual({ ok: true });
    });

    it('should return { ok: false, error } on failure', async () => {
      mockHttpClient.get.mockRejectedValue(new Error('Unauthorized'));

      const result = await provider.testConnection();

      expect(result.ok).toBe(false);
      expect(result.error).toBe('Unauthorized');
    });
  });

  describe('getDefaultBranch', () => {
    it('should return default_branch from project response', async () => {
      mockHttpClient.get.mockResolvedValue({ data: { default_branch: 'develop' } });

      const result = await provider.getDefaultBranch();

      expect(result).toBe('develop');
    });
  });

  describe('createPullRequest', () => {
    it('should create a branch then a merge request with Draft: prefix by default', async () => {
      mockHttpClient.get.mockResolvedValue({ data: { default_branch: 'main' } });
      mockHttpClient.post
        .mockResolvedValueOnce({ data: {} }) // branch creation
        .mockResolvedValueOnce({
          data: {
            iid: 5,
            web_url: 'https://gitlab.com/test/repo/-/merge_requests/5',
            state: 'opened',
            draft: true,
            source_branch: 'feature-branch',
          },
        });

      const result = await provider.createPullRequest({
        title: 'My change',
        body: 'Description',
        branchName: 'feature-branch',
      });

      expect(mockHttpClient.post).toHaveBeenNthCalledWith(
        1,
        `https://gitlab.com/api/v4/projects/${expectedProjectId}/repository/branches`,
        expect.objectContaining({
          body: { branch: 'feature-branch', ref: 'main' },
        }),
      );
      expect(mockHttpClient.post).toHaveBeenNthCalledWith(
        2,
        `https://gitlab.com/api/v4/projects/${expectedProjectId}/merge_requests`,
        expect.objectContaining({
          body: expect.objectContaining({
            source_branch: 'feature-branch',
            target_branch: 'main',
            title: 'Draft: My change',
          }),
        }),
      );
      expect(result).toEqual({
        number: 5,
        url: 'https://gitlab.com/test/repo/-/merge_requests/5',
        branchName: 'feature-branch',
        state: 'opened',
        draft: true,
      });
    });

    it('should tolerate branch-already-exists (400) and still create the MR', async () => {
      mockHttpClient.get.mockResolvedValue({ data: { default_branch: 'main' } });
      const branchError: any = new Error('Branch already exists');
      branchError.response = { status: 400 };
      mockHttpClient.post
        .mockRejectedValueOnce(branchError)
        .mockResolvedValueOnce({
          data: {
            iid: 6,
            web_url: 'https://gitlab.com/test/repo/-/merge_requests/6',
            state: 'opened',
            draft: false,
            source_branch: 'feature-branch',
          },
        });

      const result = await provider.createPullRequest({
        title: 'My change',
        body: 'Description',
        branchName: 'feature-branch',
        draft: false,
      });

      expect(result.number).toBe(6);
    });

    it('should throw ValidationAppException when no branch name is provided', async () => {
      await expect(
        provider.createPullRequest({ title: 'x', body: 'y' }),
      ).rejects.toThrow();
    });
  });

  describe('getPullRequestStatus', () => {
    it('should map GitLab MR state "opened" to "open" and merged flag from state', async () => {
      mockHttpClient.get.mockResolvedValue({
        data: {
          iid: 7,
          state: 'merged',
          draft: false,
          merged_at: '2024-02-01T00:00:00Z',
          merged_by: { username: 'merger' },
          merge_commit_sha: 'abc123',
          web_url: 'https://gitlab.com/test/repo/-/merge_requests/7',
          title: 'Merged MR',
          source_branch: 'feature-branch',
        },
      });

      const result = await provider.getPullRequestStatus(7);

      expect(result).toEqual({
        number: 7,
        state: 'merged',
        draft: false,
        merged: true,
        mergedAt: new Date('2024-02-01T00:00:00Z'),
        mergedBy: 'merger',
        mergeSha: 'abc123',
        url: 'https://gitlab.com/test/repo/-/merge_requests/7',
        title: 'Merged MR',
        branchName: 'feature-branch',
      });
    });

    it('should throw NotFoundAppException on 404', async () => {
      const error: any = new Error('Not found');
      error.response = { status: 404 };
      mockHttpClient.get.mockRejectedValue(error);

      await expect(provider.getPullRequestStatus(999)).rejects.toThrow(NotFoundAppException);
    });
  });

  describe('listPullRequests', () => {
    it('should map "open" filter to GitLab "opened" state param', async () => {
      mockHttpClient.get.mockResolvedValue({ data: [] });

      await provider.listPullRequests('open');

      expect(mockHttpClient.get).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ params: { state: 'opened' } }),
      );
    });
  });

  describe('listPrCommits', () => {
    it('should map GitLab commit shape to VcsCommit', async () => {
      mockHttpClient.get.mockResolvedValue({
        data: [
          {
            id: 'sha123',
            message: 'fix bug',
            author_name: 'Author',
            author_email: 'a@b.com',
            authored_date: '2024-01-01T00:00:00Z',
          },
        ],
      });

      const result = await provider.listPrCommits(1);

      expect(result).toEqual([
        {
          sha: 'sha123',
          message: 'fix bug',
          authorLogin: 'Author',
          url: `https://gitlab.com/${testOwner}/${testRepo}/-/commit/sha123`,
          date: new Date('2024-01-01T00:00:00Z'),
        },
      ]);
    });
  });

  describe('fetchCommitFiles', () => {
    it('should decode base64 file content and skip 404s', async () => {
      mockHttpClient.get
        .mockResolvedValueOnce({
          data: { content: Buffer.from('hello').toString('base64'), encoding: 'base64' },
        })
        .mockRejectedValueOnce(Object.assign(new Error('not found'), { response: { status: 404 } }));

      const result = await provider.fetchCommitFiles('repo-id', 'sha123', ['a.txt', 'missing.txt']);

      expect(result).toEqual([{ path: 'a.txt', content: 'hello' }]);
    });
  });
});
