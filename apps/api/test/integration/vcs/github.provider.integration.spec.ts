/**
 * GitHub Provider Integration Tests
 *
 * Verifies that GitHubProvider correctly implements IVcsProvider interface
 * by making GitHub API calls with proper authentication, filtering, and response mapping.
 *
 * Run: DATABASE_URL=file:./koda-test.db npx jest test/integration/vcs/github.provider.integration.spec.ts
 */

import { NotFoundAppException } from '@nathapp/nestjs-common';
import { GitHubProvider } from '../../../src/vcs/providers/github.provider';
import { HttpClient } from '../../../src/vcs/factory';
import { VcsIssue } from '../../../src/vcs/types';

describe('GitHubProvider (Integration)', () => {
  let provider: GitHubProvider;
  let mockHttpClient: jest.Mocked<HttpClient>;

  const testOwner = 'test-owner';
  const testRepo = 'test-repo';
  const testToken = 'test-token-123';

  beforeEach(() => {
    mockHttpClient = {
      get: jest.fn(),
    };

    provider = new GitHubProvider(testOwner, testRepo, testToken, mockHttpClient);
  });

  describe('fetchIssues', () => {
    describe('happy path', () => {
      it('should call GET /repos/{owner}/{repo}/issues with correct parameters', async () => {
        const mockResponse = {
          data: [
            {
              number: 1,
              title: 'Test Issue',
              body: 'Test body',
              user: { login: 'testuser' },
              html_url: 'https://github.com/test/repo/issues/1',
              labels: [],
              created_at: '2024-01-01T00:00:00Z',
            },
          ],
        };

        mockHttpClient.get.mockResolvedValue(mockResponse);

        await provider.fetchIssues();

        expect(mockHttpClient.get).toHaveBeenCalledWith(
          `https://api.github.com/repos/${testOwner}/${testRepo}/issues`,
          expect.objectContaining({
            headers: expect.objectContaining({
              Authorization: `Bearer ${testToken}`,
            }),
            params: expect.objectContaining({
              state: 'open',
              sort: 'created',
              direction: 'asc',
            }),
          }),
        );
      });

      it('should return mapped VcsIssue array', async () => {
        const mockResponse = {
          data: [
            {
              number: 42,
              title: 'Test Issue',
              body: 'Test body',
              user: { login: 'testuser' },
              html_url: 'https://github.com/test/repo/issues/42',
              labels: [{ name: 'bug' }, { name: 'feature' }],
              created_at: '2024-01-01T00:00:00Z',
            },
          ],
        };

        mockHttpClient.get.mockResolvedValue(mockResponse);

        const result = await provider.fetchIssues();

        expect(Array.isArray(result)).toBe(true);
        expect(result.length).toBe(1);
        expect(result[0]).toEqual({
          number: 42,
          title: 'Test Issue',
          body: 'Test body',
          authorLogin: 'testuser',
          url: 'https://github.com/test/repo/issues/42',
          labels: ['bug', 'feature'],
          createdAt: new Date('2024-01-01T00:00:00Z'),
        });
      });

      it('should handle empty issues list', async () => {
        mockHttpClient.get.mockResolvedValue({ data: [] });

        const result = await provider.fetchIssues();

        expect(Array.isArray(result)).toBe(true);
        expect(result.length).toBe(0);
      });

      it('should handle null body in GitHub response', async () => {
        const mockResponse = {
          data: [
            {
              number: 1,
              title: 'Issue without body',
              body: null,
              user: { login: 'testuser' },
              html_url: 'https://github.com/test/repo/issues/1',
              labels: [],
              created_at: '2024-01-01T00:00:00Z',
            },
          ],
        };

        mockHttpClient.get.mockResolvedValue(mockResponse);

        const result = await provider.fetchIssues();

        expect(result[0].body).toBeNull();
      });

      it('should map multiple labels correctly', async () => {
        const mockResponse = {
          data: [
            {
              number: 1,
              title: 'Multi-label issue',
              body: null,
              user: { login: 'user1' },
              html_url: 'https://github.com/test/repo/issues/1',
              labels: [
                { name: 'bug' },
                { name: 'critical' },
                { name: 'needs-review' },
              ],
              created_at: '2024-01-01T00:00:00Z',
            },
          ],
        };

        mockHttpClient.get.mockResolvedValue(mockResponse);

        const result = await provider.fetchIssues();

        expect(result[0].labels).toEqual(['bug', 'critical', 'needs-review']);
      });

      it('should handle issues with no labels', async () => {
        const mockResponse = {
          data: [
            {
              number: 1,
              title: 'No labels issue',
              body: null,
              user: { login: 'user1' },
              html_url: 'https://github.com/test/repo/issues/1',
              labels: [],
              created_at: '2024-01-01T00:00:00Z',
            },
          ],
        };

        mockHttpClient.get.mockResolvedValue(mockResponse);

        const result = await provider.fetchIssues();

        expect(result[0].labels).toEqual([]);
      });

      it('should parse ISO 8601 created_at date correctly', async () => {
        const isoDate = '2025-03-15T14:30:45Z';
        const mockResponse = {
          data: [
            {
              number: 1,
              title: 'Date test',
              body: null,
              user: { login: 'user1' },
              html_url: 'https://github.com/test/repo/issues/1',
              labels: [],
              created_at: isoDate,
            },
          ],
        };

        mockHttpClient.get.mockResolvedValue(mockResponse);

        const result = await provider.fetchIssues();

        expect(result[0].createdAt).toEqual(new Date(isoDate));
      });
    });

    describe('pull_request filtering', () => {
      it('should filter out entries where pull_request field is present', async () => {
        const mockResponse = {
          data: [
            {
              number: 1,
              title: 'Actual Issue',
              body: 'Test body',
              user: { login: 'testuser' },
              html_url: 'https://github.com/test/repo/issues/1',
              labels: [],
              created_at: '2024-01-01T00:00:00Z',
            },
            {
              number: 2,
              title: 'Pull Request as Issue',
              body: 'PR body',
              user: { login: 'testuser' },
              html_url: 'https://github.com/test/repo/pull/2',
              labels: [],
              created_at: '2024-01-02T00:00:00Z',
              pull_request: {
                url: 'https://api.github.com/repos/test/repo/pulls/2',
              },
            },
            {
              number: 3,
              title: 'Another Issue',
              body: 'Test body 3',
              user: { login: 'testuser' },
              html_url: 'https://github.com/test/repo/issues/3',
              labels: [],
              created_at: '2024-01-03T00:00:00Z',
            },
          ],
        };

        mockHttpClient.get.mockResolvedValue(mockResponse);

        const result = await provider.fetchIssues();

        expect(result.length).toBe(2);
        expect(result[0].number).toBe(1);
        expect(result[1].number).toBe(3);
      });

      it('should filter PRs even when pull_request field is empty object', async () => {
        const mockResponse = {
          data: [
            {
              number: 1,
              title: 'Actual Issue',
              body: 'Test body',
              user: { login: 'testuser' },
              html_url: 'https://github.com/test/repo/issues/1',
              labels: [],
              created_at: '2024-01-01T00:00:00Z',
            },
            {
              number: 2,
              title: 'Pull Request',
              body: 'PR body',
              user: { login: 'testuser' },
              html_url: 'https://github.com/test/repo/pull/2',
              labels: [],
              created_at: '2024-01-02T00:00:00Z',
              pull_request: {},
            },
          ],
        };

        mockHttpClient.get.mockResolvedValue(mockResponse);

        const result = await provider.fetchIssues();

        expect(result.length).toBe(1);
        expect(result[0].number).toBe(1);
      });

      it('should include issues when pull_request field is undefined', async () => {
        const mockResponse = {
          data: [
            {
              number: 1,
              title: 'Issue without pull_request field',
              body: 'Test body',
              user: { login: 'testuser' },
              html_url: 'https://github.com/test/repo/issues/1',
              labels: [],
              created_at: '2024-01-01T00:00:00Z',
            },
          ],
        };

        mockHttpClient.get.mockResolvedValue(mockResponse);

        const result = await provider.fetchIssues();

        expect(result.length).toBe(1);
        expect(result[0].number).toBe(1);
      });
    });

    describe('since parameter', () => {
      it('should pass ISO 8601 since parameter when provided', async () => {
        const sinceDate = new Date('2024-01-15T10:30:00Z');
        mockHttpClient.get.mockResolvedValue({ data: [] });

        await provider.fetchIssues(sinceDate);

        expect(mockHttpClient.get).toHaveBeenCalledWith(
          expect.any(String),
          expect.objectContaining({
            params: expect.objectContaining({
              since: sinceDate.toISOString(),
            }),
          }),
        );
      });

      it('should not include since parameter when not provided', async () => {
        mockHttpClient.get.mockResolvedValue({ data: [] });

        await provider.fetchIssues();

        const callArgs = mockHttpClient.get.mock.calls[0];
        expect(callArgs[1].params).not.toHaveProperty('since');
      });

      it('should convert since Date to ISO string correctly', async () => {
        const sinceDate = new Date('2025-03-15T14:30:45.123Z');
        mockHttpClient.get.mockResolvedValue({ data: [] });

        await provider.fetchIssues(sinceDate);

        const callArgs = mockHttpClient.get.mock.calls[0];
        expect(callArgs[1].params.since).toBe('2025-03-15T14:30:45.123Z');
      });
    });

    describe('authorization header', () => {
      it('should include Authorization Bearer header with token', async () => {
        mockHttpClient.get.mockResolvedValue({ data: [] });

        await provider.fetchIssues();

        expect(mockHttpClient.get).toHaveBeenCalledWith(
          expect.any(String),
          expect.objectContaining({
            headers: expect.objectContaining({
              Authorization: `Bearer ${testToken}`,
            }),
          }),
        );
      });

      it('should use correct Authorization format', async () => {
        mockHttpClient.get.mockResolvedValue({ data: [] });

        await provider.fetchIssues();

        const callArgs = mockHttpClient.get.mock.calls[0];
        const authHeader = callArgs[1].headers.Authorization;
        expect(authHeader).toMatch(/^Bearer /);
      });
    });
  });

  describe('fetchIssue', () => {
    describe('happy path', () => {
      it('should call GET /repos/{owner}/{repo}/issues/{issueNumber}', async () => {
        const issueNumber = 42;
        const mockResponse = {
          data: {
            number: issueNumber,
            title: 'Test Issue',
            body: 'Test body',
            user: { login: 'testuser' },
            html_url: 'https://github.com/test/repo/issues/42',
            labels: [],
            created_at: '2024-01-01T00:00:00Z',
          },
        };

        mockHttpClient.get.mockResolvedValue(mockResponse);

        await provider.fetchIssue(issueNumber);

        expect(mockHttpClient.get).toHaveBeenCalledWith(
          `https://api.github.com/repos/${testOwner}/${testRepo}/issues/${issueNumber}`,
          expect.objectContaining({
            headers: expect.objectContaining({
              Authorization: `Bearer ${testToken}`,
            }),
          }),
        );
      });

      it('should return mapped VcsIssue', async () => {
        const mockResponse = {
          data: {
            number: 42,
            title: 'Test Issue',
            body: 'Test body',
            user: { login: 'testuser' },
            html_url: 'https://github.com/test/repo/issues/42',
            labels: [{ name: 'bug' }],
            created_at: '2024-01-01T00:00:00Z',
          },
        };

        mockHttpClient.get.mockResolvedValue(mockResponse);

        const result = await provider.fetchIssue(42);

        expect(result).toEqual({
          number: 42,
          title: 'Test Issue',
          body: 'Test body',
          authorLogin: 'testuser',
          url: 'https://github.com/test/repo/issues/42',
          labels: ['bug'],
          createdAt: new Date('2024-01-01T00:00:00Z'),
        });
      });

      it('should handle null body', async () => {
        const mockResponse = {
          data: {
            number: 1,
            title: 'Issue without body',
            body: null,
            user: { login: 'testuser' },
            html_url: 'https://github.com/test/repo/issues/1',
            labels: [],
            created_at: '2024-01-01T00:00:00Z',
          },
        };

        mockHttpClient.get.mockResolvedValue(mockResponse);

        const result = await provider.fetchIssue(1);

        expect(result.body).toBeNull();
      });

      it('should map multiple labels correctly', async () => {
        const mockResponse = {
          data: {
            number: 1,
            title: 'Multi-label issue',
            body: 'Description',
            user: { login: 'user1' },
            html_url: 'https://github.com/test/repo/issues/1',
            labels: [
              { name: 'bug' },
              { name: 'critical' },
              { name: 'needs-review' },
            ],
            created_at: '2024-01-01T00:00:00Z',
          },
        };

        mockHttpClient.get.mockResolvedValue(mockResponse);

        const result = await provider.fetchIssue(1);

        expect(result.labels).toEqual(['bug', 'critical', 'needs-review']);
      });

      it('should parse ISO 8601 created_at correctly', async () => {
        const isoDate = '2025-03-15T14:30:45Z';
        const mockResponse = {
          data: {
            number: 1,
            title: 'Date test',
            body: null,
            user: { login: 'user1' },
            html_url: 'https://github.com/test/repo/issues/1',
            labels: [],
            created_at: isoDate,
          },
        };

        mockHttpClient.get.mockResolvedValue(mockResponse);

        const result = await provider.fetchIssue(1);

        expect(result.createdAt).toEqual(new Date(isoDate));
      });
    });

    describe('error handling', () => {
      it('should throw NotFoundAppException when GitHub returns 404', async () => {
        const error: any = new Error('Not found');
        error.response = { status: 404 };

        mockHttpClient.get.mockRejectedValue(error);

        await expect(provider.fetchIssue(9999)).rejects.toThrow(
          NotFoundAppException,
        );
      });

      it('should throw NotFoundAppException for 404 responses', async () => {
        const issueNumber = 9999;
        const error: any = new Error('Not found');
        error.response = { status: 404 };

        mockHttpClient.get.mockRejectedValue(error);

        const thrown = await provider.fetchIssue(issueNumber).catch((e) => e);
        expect(thrown).toBeInstanceOf(NotFoundAppException);
      });

      it('should re-throw non-404 errors', async () => {
        const originalError = new Error('Network error');

        mockHttpClient.get.mockRejectedValue(originalError);

        await expect(provider.fetchIssue(1)).rejects.toThrow(
          'Network error',
        );
      });

      it('should re-throw errors without response object', async () => {
        const error = new Error('Unknown error');

        mockHttpClient.get.mockRejectedValue(error);

        await expect(provider.fetchIssue(1)).rejects.toThrow(
          'Unknown error',
        );
      });
    });

    describe('authorization header', () => {
      it('should include Authorization Bearer header with token', async () => {
        mockHttpClient.get.mockResolvedValue({
          data: {
            number: 1,
            title: 'Test',
            body: null,
            user: { login: 'user' },
            html_url: 'https://github.com/test/repo/issues/1',
            labels: [],
            created_at: '2024-01-01T00:00:00Z',
          },
        });

        await provider.fetchIssue(1);

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
  });

  describe('testConnection', () => {
    describe('happy path', () => {
      it('should call GET /repos/{owner}/{repo}', async () => {
        mockHttpClient.get.mockResolvedValue({ data: {} });

        await provider.testConnection();

        expect(mockHttpClient.get).toHaveBeenCalledWith(
          `https://api.github.com/repos/${testOwner}/${testRepo}`,
          expect.objectContaining({
            headers: expect.objectContaining({
              Authorization: `Bearer ${testToken}`,
            }),
          }),
        );
      });

      it('should return { ok: true } when successful', async () => {
        mockHttpClient.get.mockResolvedValue({ data: { id: 123 } });

        const result = await provider.testConnection();

        expect(result).toEqual({ ok: true });
      });

      it('should have ok property set to true', async () => {
        mockHttpClient.get.mockResolvedValue({ data: {} });

        const result = await provider.testConnection();

        expect(result.ok).toBe(true);
      });

      it('should not include error property on success', async () => {
        mockHttpClient.get.mockResolvedValue({ data: {} });

        const result = await provider.testConnection();

        expect('error' in result).toBe(false);
      });

      it('should handle repo data in response', async () => {
        mockHttpClient.get.mockResolvedValue({
          data: {
            id: 123,
            name: 'test-repo',
            owner: { login: 'test-owner' },
          },
        });

        const result = await provider.testConnection();

        expect(result.ok).toBe(true);
      });
    });

    describe('error handling', () => {
      it('should return { ok: false, error: message } on error', async () => {
        const error: any = new Error('Unauthorized');

        mockHttpClient.get.mockRejectedValue(error);

        const result = await provider.testConnection();

        expect(result.ok).toBe(false);
        expect(result.error).toBe('Unauthorized');
      });

      it('should handle 404 (repo not found) by returning ok: false', async () => {
        const error: any = new Error('Not found');
        error.response = { status: 404 };

        mockHttpClient.get.mockRejectedValue(error);

        const result = await provider.testConnection();

        expect(result.ok).toBe(false);
        expect(typeof result.error).toBe('string');
      });

      it('should handle 401 (invalid token) by returning ok: false', async () => {
        const error: any = new Error('Unauthorized');
        error.response = { status: 401 };

        mockHttpClient.get.mockRejectedValue(error);

        const result = await provider.testConnection();

        expect(result.ok).toBe(false);
        expect(result.error).toBe('Unauthorized');
      });

      it('should use error message as error string', async () => {
        const errorMessage = 'Network timeout';
        const error: any = new Error(errorMessage);

        mockHttpClient.get.mockRejectedValue(error);

        const result = await provider.testConnection();

        expect(result.error).toBe(errorMessage);
      });

      it('should handle errors without message property', async () => {
        const error: any = new Error();
        error.message = undefined;

        mockHttpClient.get.mockRejectedValue(error);

        const result = await provider.testConnection();

        expect(result.ok).toBe(false);
        expect(typeof result.error).toBe('string');
      });

      it('should not throw, only return error status', async () => {
        const error = new Error('Unauthorized');

        mockHttpClient.get.mockRejectedValue(error);

        await expect(provider.testConnection()).resolves.toBeDefined();
      });
    });

    describe('authorization header', () => {
      it('should include Authorization Bearer header with token', async () => {
        mockHttpClient.get.mockResolvedValue({ data: {} });

        await provider.testConnection();

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
  });

  describe('constructor and initialization', () => {
    it('should create instance with owner, repo, token, and httpClient', () => {
      expect(provider).toBeInstanceOf(GitHubProvider);
    });

    it('should implement IVcsProvider interface', async () => {
      expect(typeof provider.fetchIssues).toBe('function');
      expect(typeof provider.fetchIssue).toBe('function');
      expect(typeof provider.testConnection).toBe('function');
    });

    it('should accept different tokens', async () => {
      const differentToken = 'different-token-xyz';
      const differentProvider = new GitHubProvider(
        testOwner,
        testRepo,
        differentToken,
        mockHttpClient,
      );

      mockHttpClient.get.mockResolvedValue({ data: [] });

      await differentProvider.fetchIssues();

      const callArgs = mockHttpClient.get.mock.calls[0];
      expect(callArgs[1].headers.Authorization).toBe(
        `Bearer ${differentToken}`,
      );
    });

    it('should accept different owner and repo', async () => {
      const differentProvider = new GitHubProvider(
        'different-owner',
        'different-repo',
        testToken,
        mockHttpClient,
      );

      mockHttpClient.get.mockResolvedValue({ data: [] });

      await differentProvider.fetchIssues();

      const callArgs = mockHttpClient.get.mock.calls[0];
      expect(callArgs[0]).toContain('different-owner');
      expect(callArgs[0]).toContain('different-repo');
    });
  });

  describe('GitHub API URL construction', () => {
    it('should use https://api.github.com as base URL', async () => {
      mockHttpClient.get.mockResolvedValue({ data: [] });

      await provider.fetchIssues();

      const callArgs = mockHttpClient.get.mock.calls[0];
      expect(callArgs[0]).toMatch(/^https:\/\/api\.github\.com/);
    });

    it('should construct correct URL for fetchIssues', async () => {
      mockHttpClient.get.mockResolvedValue({ data: [] });

      await provider.fetchIssues();

      expect(mockHttpClient.get).toHaveBeenCalledWith(
        'https://api.github.com/repos/test-owner/test-repo/issues',
        expect.any(Object),
      );
    });

    it('should construct correct URL for fetchIssue with issue number', async () => {
      mockHttpClient.get.mockResolvedValue({
        data: {
          number: 42,
          title: 'Test',
          body: null,
          user: { login: 'user' },
          html_url: 'https://github.com/test/repo/issues/42',
          labels: [],
          created_at: '2024-01-01T00:00:00Z',
        },
      });

      await provider.fetchIssue(42);

      expect(mockHttpClient.get).toHaveBeenCalledWith(
        'https://api.github.com/repos/test-owner/test-repo/issues/42',
        expect.any(Object),
      );
    });

    it('should construct correct URL for testConnection', async () => {
      mockHttpClient.get.mockResolvedValue({ data: {} });

      await provider.testConnection();

      expect(mockHttpClient.get).toHaveBeenCalledWith(
        'https://api.github.com/repos/test-owner/test-repo',
        expect.any(Object),
      );
    });
  });
});
