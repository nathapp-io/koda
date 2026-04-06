/**
 * GitHubProvider PR Methods Integration Tests
 *
 * Tests for GitHubProvider.getDefaultBranch() and GitHubProvider.createPullRequest() methods.
 * Verifies correct GitHub API calls with proper authentication and response mapping.
 *
 * Run: DATABASE_URL=file:./koda-test.db bun test test/integration/vcs/github-pr.integration.spec.ts
 */

import { GitHubProvider } from '../../../src/vcs/providers/github.provider';
import { HttpClient } from '../../../src/vcs/factory';
import { CreatePrParams, VcsPullRequest } from '../../../src/vcs/types';

describe('GitHubProvider PR Methods', () => {
  let provider: GitHubProvider;
  let mockHttpClient: jest.Mocked<HttpClient>;

  const testOwner = 'test-owner';
  const testRepo = 'test-repo';
  const testToken = 'test-token-123';

  beforeEach(() => {
    mockHttpClient = {
      get: jest.fn(),
      post: jest.fn(),
    };

    provider = new GitHubProvider(testOwner, testRepo, testToken, mockHttpClient);
  });

  describe('getDefaultBranch', () => {
    describe('AC7: Returns repository default branch via GET /repos/{owner}/{repo}', () => {
      it('calls GET /repos/{owner}/{repo} to fetch repo info', async () => {
        mockHttpClient.get.mockResolvedValue({
          data: { default_branch: 'main' },
        });

        await provider.getDefaultBranch();

        expect(mockHttpClient.get).toHaveBeenCalledWith(
          `https://api.github.com/repos/${testOwner}/${testRepo}`,
          expect.objectContaining({
            headers: expect.objectContaining({
              Authorization: `Bearer ${testToken}`,
            }),
          }),
        );
      });

      it('returns the default_branch field from GitHub API response', async () => {
        mockHttpClient.get.mockResolvedValue({
          data: { default_branch: 'main' },
        });

        const result = await provider.getDefaultBranch();

        expect(result).toBe('main');
      });

      it('returns master when that is the default branch', async () => {
        mockHttpClient.get.mockResolvedValue({
          data: { default_branch: 'master' },
        });

        const result = await provider.getDefaultBranch();

        expect(result).toBe('master');
      });

      it('returns develop when that is the default branch', async () => {
        mockHttpClient.get.mockResolvedValue({
          data: { default_branch: 'develop' },
        });

        const result = await provider.getDefaultBranch();

        expect(result).toBe('develop');
      });

      it('uses correct Authorization Bearer header', async () => {
        mockHttpClient.get.mockResolvedValue({
          data: { default_branch: 'main' },
        });

        await provider.getDefaultBranch();

        expect(mockHttpClient.get).toHaveBeenCalledWith(
          expect.any(String),
          expect.objectContaining({
            headers: expect.objectContaining({
              Authorization: `Bearer ${testToken}`,
            }),
          }),
        );
      });
    });

    describe('error handling', () => {
      it('propagates error when GitHub API call fails', async () => {
        const error = new Error('Network error');
        mockHttpClient.get.mockRejectedValue(error);

        await expect(provider.getDefaultBranch()).rejects.toThrow(
          'Network error',
        );
      });

      it('throws when repository is not found (404)', async () => {
        const error: any = new Error('Not found');
        error.response = { status: 404 };
        mockHttpClient.get.mockRejectedValue(error);

        await expect(provider.getDefaultBranch()).rejects.toThrow('Not found');
      });

      it('throws when token is invalid (401)', async () => {
        const error: any = new Error('Unauthorized');
        error.response = { status: 401 };
        mockHttpClient.get.mockRejectedValue(error);

        await expect(provider.getDefaultBranch()).rejects.toThrow(
          'Unauthorized',
        );
      });
    });
  });

  describe('createPullRequest', () => {
    describe('AC8: Creates new branch from default branch HEAD via POST /repos/{owner}/{repo}/git/refs', () => {
      it('fetches default branch first to get the SHA', async () => {
        mockHttpClient.get.mockResolvedValue({
          data: { default_branch: 'main' },
        });
        mockHttpClient.post.mockResolvedValue({
          data: { ref: 'refs/heads/feature-branch', object: { sha: 'abc123' } },
        });

        const params: CreatePrParams = {
          title: 'Test PR',
          body: 'Test body',
          headBranch: 'feature-branch',
          baseBranch: 'main',
        };

        await provider.createPullRequest(params);

        expect(mockHttpClient.get).toHaveBeenCalledWith(
          `https://api.github.com/repos/${testOwner}/${testRepo}`,
          expect.any(Object),
        );
      });

      it('creates branch ref via POST /repos/{owner}/{repo}/git/refs', async () => {
        mockHttpClient.get.mockResolvedValue({
          data: { default_branch: 'main' },
        });
        mockHttpClient.post.mockResolvedValue({
          data: { ref: 'refs/heads/feature-branch', object: { sha: 'abc123' } },
        });

        const params: CreatePrParams = {
          title: 'Test PR',
          body: 'Test body',
          headBranch: 'feature-branch',
          baseBranch: 'main',
        };

        await provider.createPullRequest(params);

        expect(mockHttpClient.post).toHaveBeenCalledWith(
          `https://api.github.com/repos/${testOwner}/${testRepo}/git/refs`,
          expect.objectContaining({
            headers: expect.objectContaining({
              Authorization: `Bearer ${testToken}`,
            }),
          }),
        );
      });

      it('includes correct ref format in branch creation request', async () => {
        mockHttpClient.get.mockResolvedValue({
          data: { default_branch: 'main' },
        });
        mockHttpClient.post.mockResolvedValue({
          data: { ref: 'refs/heads/feature-branch', object: { sha: 'abc123' } },
        });

        const params: CreatePrParams = {
          title: 'Test PR',
          body: 'Test body',
          headBranch: 'feature-branch',
          baseBranch: 'main',
        };

        await provider.createPullRequest(params);

        const postCall = mockHttpClient.post.mock.calls[1];
        const body = postCall[1].body as { ref: string };
        expect(body.ref).toBe('refs/heads/feature-branch');
      });
    });

    describe('AC9: Opens draft PR targeting default branch via POST /repos/{owner}/{repo}/pulls', () => {
      it('creates PR via POST /repos/{owner}/{repo}/pulls', async () => {
        mockHttpClient.get.mockResolvedValue({
          data: { default_branch: 'main' },
        });
        mockHttpClient.post.mockResolvedValue({
          data: {
            number: 42,
            html_url: 'https://github.com/owner/repo/pull/42',
            state: 'open',
            draft: true,
          },
        });

        const params: CreatePrParams = {
          title: 'Test PR',
          body: 'Test body',
          headBranch: 'feature-branch',
          baseBranch: 'main',
        };

        await provider.createPullRequest(params);

        expect(mockHttpClient.post).toHaveBeenCalledWith(
          `https://api.github.com/repos/${testOwner}/${testRepo}/pulls`,
          expect.any(Object),
        );
      });

      it('sets head to the feature branch name', async () => {
        mockHttpClient.get.mockResolvedValue({
          data: { default_branch: 'main' },
        });
        mockHttpClient.post.mockResolvedValue({
          data: {
            number: 42,
            html_url: 'https://github.com/owner/repo/pull/42',
            state: 'open',
            draft: true,
          },
        });

        const params: CreatePrParams = {
          title: 'Test PR',
          body: 'Test body',
          headBranch: 'koda/KODA-42/fix-login-bug',
          baseBranch: 'main',
        };

        await provider.createPullRequest(params);

        const postCall = mockHttpClient.post.mock.calls[2];
        const body = postCall[1].body as { head: string };
        expect(body.head).toBe('koda/KODA-42/fix-login-bug');
      });

      it('sets base to the default branch name', async () => {
        mockHttpClient.get.mockResolvedValue({
          data: { default_branch: 'main' },
        });
        mockHttpClient.post.mockResolvedValue({
          data: {
            number: 42,
            html_url: 'https://github.com/owner/repo/pull/42',
            state: 'open',
            draft: true,
          },
        });

        const params: CreatePrParams = {
          title: 'Test PR',
          body: 'Test body',
          headBranch: 'feature-branch',
          baseBranch: 'main',
        };

        await provider.createPullRequest(params);

        const postCall = mockHttpClient.post.mock.calls[2];
        const body = postCall[1].body as { base: string };
        expect(body.base).toBe('main');
      });

      it('sets draft to true in PR creation request', async () => {
        mockHttpClient.get.mockResolvedValue({
          data: { default_branch: 'main' },
        });
        mockHttpClient.post.mockResolvedValue({
          data: {
            number: 42,
            html_url: 'https://github.com/owner/repo/pull/42',
            state: 'open',
            draft: true,
          },
        });

        const params: CreatePrParams = {
          title: 'Test PR',
          body: 'Test body',
          headBranch: 'feature-branch',
          baseBranch: 'main',
        };

        await provider.createPullRequest(params);

        const postCall = mockHttpClient.post.mock.calls[2];
        const body = postCall[1].body as { draft: boolean };
        expect(body.draft).toBe(true);
      });

      it('includes title and body in PR creation request', async () => {
        mockHttpClient.get.mockResolvedValue({
          data: { default_branch: 'main' },
        });
        mockHttpClient.post.mockResolvedValue({
          data: {
            number: 42,
            html_url: 'https://github.com/owner/repo/pull/42',
            state: 'open',
            draft: true,
          },
        });

        const params: CreatePrParams = {
          title: 'Fix login redirect bug',
          body: 'This PR fixes the login redirect bug',
          headBranch: 'feature-branch',
          baseBranch: 'main',
        };

        await provider.createPullRequest(params);

        const postCall = mockHttpClient.post.mock.calls[2];
        const body = postCall[1].body as { title: string; body: string };
        expect(body.title).toBe('Fix login redirect bug');
        expect(body.body).toBe('This PR fixes the login redirect bug');
      });
    });

    describe('AC10: Returns VcsPullRequest with number, url, branchName, state, and draft fields', () => {
      it('returns VcsPullRequest with number from GitHub response', async () => {
        mockHttpClient.get.mockResolvedValue({
          data: { default_branch: 'main' },
        });
        mockHttpClient.post.mockResolvedValue({
          data: {
            number: 42,
            html_url: 'https://github.com/owner/repo/pull/42',
            state: 'open',
            draft: true,
          },
        });

        const params: CreatePrParams = {
          title: 'Test PR',
          body: 'Test body',
          headBranch: 'feature-branch',
          baseBranch: 'main',
        };

        const result = await provider.createPullRequest(params);

        expect(result.number).toBe(42);
      });

      it('returns VcsPullRequest with url from GitHub response', async () => {
        mockHttpClient.get.mockResolvedValue({
          data: { default_branch: 'main' },
        });
        mockHttpClient.post.mockResolvedValue({
          data: {
            number: 42,
            html_url: 'https://github.com/owner/repo/pull/42',
            state: 'open',
            draft: true,
          },
        });

        const params: CreatePrParams = {
          title: 'Test PR',
          body: 'Test body',
          headBranch: 'feature-branch',
          baseBranch: 'main',
        };

        const result = await provider.createPullRequest(params);

        expect(result.url).toBe('https://github.com/owner/repo/pull/42');
      });

      it('returns VcsPullRequest with branchName set to headBranch', async () => {
        mockHttpClient.get.mockResolvedValue({
          data: { default_branch: 'main' },
        });
        mockHttpClient.post.mockResolvedValue({
          data: {
            number: 42,
            html_url: 'https://github.com/owner/repo/pull/42',
            state: 'open',
            draft: true,
          },
        });

        const params: CreatePrParams = {
          title: 'Test PR',
          body: 'Test body',
          headBranch: 'koda/KODA-42/fix-login-bug',
          baseBranch: 'main',
        };

        const result = await provider.createPullRequest(params);

        expect(result.branchName).toBe('koda/KODA-42/fix-login-bug');
      });

      it('returns VcsPullRequest with state from GitHub response', async () => {
        mockHttpClient.get.mockResolvedValue({
          data: { default_branch: 'main' },
        });
        mockHttpClient.post.mockResolvedValue({
          data: {
            number: 42,
            html_url: 'https://github.com/owner/repo/pull/42',
            state: 'open',
            draft: true,
          },
        });

        const params: CreatePrParams = {
          title: 'Test PR',
          body: 'Test body',
          headBranch: 'feature-branch',
          baseBranch: 'main',
        };

        const result = await provider.createPullRequest(params);

        expect(result.state).toBe('open');
      });

      it('returns VcsPullRequest with draft true for draft PRs', async () => {
        mockHttpClient.get.mockResolvedValue({
          data: { default_branch: 'main' },
        });
        mockHttpClient.post.mockResolvedValue({
          data: {
            number: 42,
            html_url: 'https://github.com/owner/repo/pull/42',
            state: 'open',
            draft: true,
          },
        });

        const params: CreatePrParams = {
          title: 'Test PR',
          body: 'Test body',
          headBranch: 'feature-branch',
          baseBranch: 'main',
        };

        const result = await provider.createPullRequest(params);

        expect(result.draft).toBe(true);
      });
    });

    describe('AC11: When branch already exists (HTTP 422 on ref creation) skips branch creation and proceeds to create PR', () => {
      it('handles HTTP 422 error on ref creation by proceeding to PR creation', async () => {
        const error422: any = new Error('Reference already exists');
        error422.response = { status: 422 };
        mockHttpClient.get.mockResolvedValue({
          data: { default_branch: 'main' },
        });
        mockHttpClient.post
          .mockRejectedValueOnce(error422)
          .mockResolvedValueOnce({
            data: { ref: 'refs/heads/feature-branch', object: { sha: 'abc123' } },
          })
          .mockResolvedValueOnce({
            data: {
              number: 42,
              html_url: 'https://github.com/owner/repo/pull/42',
              state: 'open',
              draft: true,
            },
          });

        const params: CreatePrParams = {
          title: 'Test PR',
          body: 'Test body',
          headBranch: 'feature-branch',
          baseBranch: 'main',
        };

        const result = await provider.createPullRequest(params);

        expect(mockHttpClient.post).toHaveBeenCalledTimes(3);
        expect(result.number).toBe(42);
      });

      it('returns VcsPullRequest when branch already exists', async () => {
        const error422: any = new Error('Reference already exists');
        error422.response = { status: 422 };
        mockHttpClient.get.mockResolvedValue({
          data: { default_branch: 'main' },
        });
        mockHttpClient.post
          .mockRejectedValueOnce(error422)
          .mockResolvedValueOnce({
            data: { ref: 'refs/heads/feature-branch', object: { sha: 'abc123' } },
          })
          .mockResolvedValueOnce({
            data: {
              number: 42,
              html_url: 'https://github.com/owner/repo/pull/42',
              state: 'open',
              draft: true,
            },
          });

        const params: CreatePrParams = {
          title: 'Test PR',
          body: 'Test body',
          headBranch: 'feature-branch',
          baseBranch: 'main',
        };

        const result = await provider.createPullRequest(params);

        expect(result).toEqual({
          number: 42,
          url: 'https://github.com/owner/repo/pull/42',
          branchName: 'feature-branch',
          state: 'open',
          draft: true,
        });
      });
    });

    describe('authorization header', () => {
      it('includes Authorization Bearer header with token for all GitHub API calls', async () => {
        mockHttpClient.get.mockResolvedValue({
          data: { default_branch: 'main' },
        });
        mockHttpClient.post.mockResolvedValue({
          data: { ref: 'refs/heads/feature-branch', object: { sha: 'abc123' } },
        });

        const params: CreatePrParams = {
          title: 'Test PR',
          body: 'Test body',
          headBranch: 'feature-branch',
          baseBranch: 'main',
        };

        await provider.createPullRequest(params);

        const allCalls = mockHttpClient.post.mock.calls;
        allCalls.forEach((call) => {
          const headers = call[1].headers as Record<string, string>;
          expect(headers.Authorization).toBe(`Bearer ${testToken}`);
        });
      });
    });
  });

  describe('IVcsProvider interface compliance', () => {
    it('implements getDefaultBranch method', () => {
      expect(typeof provider.getDefaultBranch).toBe('function');
    });

    it('implements createPullRequest method', () => {
      expect(typeof provider.createPullRequest).toBe('function');
    });
  });
});
