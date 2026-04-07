/**
 * GitHub Provider PR Status Tests
 *
 * Tests for GitHubProvider.getPullRequestStatus() and GitHubProvider.listPullRequests()
 * methods including 404 error handling.
 *
 * Run: bun test test/integration/vcs/github-pr-status.integration.spec.ts
 */

import { NotFoundAppException } from '@nathapp/nestjs-common';
import { GitHubProvider } from '../../../src/vcs/providers/github.provider';
import { HttpClient } from '../../../src/vcs/factory';
import { VcsPrStatus } from '../../../src/vcs/types';

describe('GitHubProvider PR Status Methods', () => {
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

  describe('getPullRequestStatus', () => {
    describe('happy path', () => {
      it('should call GET /repos/{owner}/{repo}/pulls/{prNumber} with correct parameters', async () => {
        const prNumber = 42;
        const mockResponse = {
          data: {
            number: prNumber,
            state: 'open',
            draft: false,
            merged: false,
            merged_at: null,
            merged_by: null,
            merge_commit_sha: null,
            html_url: `https://github.com/${testOwner}/${testRepo}/pull/${prNumber}`,
            title: 'Test PR',
          },
        };

        mockHttpClient.get.mockResolvedValue(mockResponse);

        await provider.getPullRequestStatus(prNumber);

        expect(mockHttpClient.get).toHaveBeenCalledWith(
          `https://api.github.com/repos/${testOwner}/${testRepo}/pulls/${prNumber}`,
          expect.objectContaining({
            headers: expect.objectContaining({
              Authorization: `Bearer ${testToken}`,
            }),
          }),
        );
      });

      it('should return VcsPrStatus with correct mapping for open PR', async () => {
        const prNumber = 42;
        const mockResponse = {
          data: {
            number: prNumber,
            state: 'open',
            draft: false,
            merged: false,
            merged_at: null,
            merged_by: null,
            merge_commit_sha: null,
            html_url: `https://github.com/${testOwner}/${testRepo}/pull/${prNumber}`,
            title: 'Open PR Title',
          },
        };

        mockHttpClient.get.mockResolvedValue(mockResponse);

        const result = await provider.getPullRequestStatus(prNumber);

        expect(result).toEqual({
          number: prNumber,
          state: 'open',
          draft: false,
          merged: false,
          mergedAt: null,
          mergedBy: null,
          mergeSha: null,
          url: `https://github.com/${testOwner}/${testRepo}/pull/${prNumber}`,
          title: 'Open PR Title',
        });
      });

      it('should return VcsPrStatus with correct mapping for merged PR', async () => {
        const prNumber = 42;
        const mergedAt = '2024-01-15T10:30:00Z';
        const mockResponse = {
          data: {
            number: prNumber,
            state: 'closed',
            draft: false,
            merged: true,
            merged_at: mergedAt,
            merged_by: { login: 'octocat' },
            merge_commit_sha: 'sha123abc',
            html_url: `https://github.com/${testOwner}/${testRepo}/pull/${prNumber}`,
            title: 'Merged PR Title',
          },
        };

        mockHttpClient.get.mockResolvedValue(mockResponse);

        const result = await provider.getPullRequestStatus(prNumber);

        expect(result).toEqual({
          number: prNumber,
          state: 'closed',
          draft: false,
          merged: true,
          mergedAt: new Date(mergedAt),
          mergedBy: 'octocat',
          mergeSha: 'sha123abc',
          url: `https://github.com/${testOwner}/${testRepo}/pull/${prNumber}`,
          title: 'Merged PR Title',
        });
      });

      it('should return VcsPrStatus for draft PR', async () => {
        const prNumber = 1;
        const mockResponse = {
          data: {
            number: prNumber,
            state: 'open',
            draft: true,
            merged: false,
            merged_at: null,
            merged_by: null,
            merge_commit_sha: null,
            html_url: `https://github.com/${testOwner}/${testRepo}/pull/${prNumber}`,
            title: 'Draft PR',
          },
        };

        mockHttpClient.get.mockResolvedValue(mockResponse);

        const result = await provider.getPullRequestStatus(prNumber);

        expect(result.draft).toBe(true);
        expect(result.merged).toBe(false);
        expect(result.mergedAt).toBeNull();
        expect(result.mergedBy).toBeNull();
        expect(result.mergeSha).toBeNull();
      });
    });

    describe('error handling', () => {
      it('should throw NotFoundAppException when GitHub returns 404', async () => {
        const prNumber = 9999;
        const error: any = new Error('Not found');
        error.response = { status: 404 };

        mockHttpClient.get.mockRejectedValue(error);

        await expect(provider.getPullRequestStatus(prNumber)).rejects.toThrow(
          NotFoundAppException,
        );
      });

      it('should throw NotFoundAppException with PR number in message', async () => {
        const prNumber = 42;
        const error: any = new Error('Not found');
        error.response = { status: 404 };

        mockHttpClient.get.mockRejectedValue(error);

        await expect(provider.getPullRequestStatus(prNumber)).rejects.toThrow(
          `PR #${prNumber} not found`,
        );
      });

      it('should re-throw non-404 errors', async () => {
        const prNumber = 1;
        const originalError = new Error('Network error');

        mockHttpClient.get.mockRejectedValue(originalError);

        await expect(provider.getPullRequestStatus(prNumber)).rejects.toThrow(
          'Network error',
        );
      });
    });

    describe('authorization header', () => {
      it('should include Authorization Bearer header with token', async () => {
        const prNumber = 42;
        mockHttpClient.get.mockResolvedValue({
          data: {
            number: prNumber,
            state: 'open',
            draft: false,
            merged: false,
            merged_at: null,
            merged_by: null,
            merge_commit_sha: null,
            html_url: `https://github.com/${testOwner}/${testRepo}/pull/${prNumber}`,
            title: 'Test PR',
          },
        });

        await provider.getPullRequestStatus(prNumber);

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

  describe('listPullRequests', () => {
    describe('happy path', () => {
      it('should call GET /repos/{owner}/{repo}/pulls with state=open when no argument provided', async () => {
        mockHttpClient.get.mockResolvedValue({ data: [] });

        await provider.listPullRequests();

        expect(mockHttpClient.get).toHaveBeenCalledWith(
          `https://api.github.com/repos/${testOwner}/${testRepo}/pulls`,
          expect.objectContaining({
            headers: expect.objectContaining({
              Authorization: `Bearer ${testToken}`,
            }),
            params: expect.objectContaining({
              state: 'open',
            }),
          }),
        );
      });

      it('should call GET /repos/{owner}/{repo}/pulls with state=open when called with "open"', async () => {
        mockHttpClient.get.mockResolvedValue({ data: [] });

        await provider.listPullRequests('open');

        expect(mockHttpClient.get).toHaveBeenCalledWith(
          `https://api.github.com/repos/${testOwner}/${testRepo}/pulls`,
          expect.objectContaining({
            params: expect.objectContaining({
              state: 'open',
            }),
          }),
        );
      });

      it('should call GET /repos/{owner}/{repo}/pulls with state=closed when called with "closed"', async () => {
        mockHttpClient.get.mockResolvedValue({ data: [] });

        await provider.listPullRequests('closed');

        expect(mockHttpClient.get).toHaveBeenCalledWith(
          `https://api.github.com/repos/${testOwner}/${testRepo}/pulls`,
          expect.objectContaining({
            params: expect.objectContaining({
              state: 'closed',
            }),
          }),
        );
      });

      it('should call GET /repos/{owner}/{repo}/pulls with state=all when called with "all"', async () => {
        mockHttpClient.get.mockResolvedValue({ data: [] });

        await provider.listPullRequests('all');

        expect(mockHttpClient.get).toHaveBeenCalledWith(
          `https://api.github.com/repos/${testOwner}/${testRepo}/pulls`,
          expect.objectContaining({
            params: expect.objectContaining({
              state: 'all',
            }),
          }),
        );
      });

      it('should return array of VcsPrStatus', async () => {
        const mockResponse = {
          data: [
            {
              number: 1,
              state: 'open',
              draft: false,
              merged: false,
              merged_at: null,
              merged_by: null,
              merge_commit_sha: null,
              html_url: `https://github.com/${testOwner}/${testRepo}/pull/1`,
              title: 'PR One',
            },
            {
              number: 2,
              state: 'open',
              draft: true,
              merged: false,
              merged_at: null,
              merged_by: null,
              merge_commit_sha: null,
              html_url: `https://github.com/${testOwner}/${testRepo}/pull/2`,
              title: 'PR Two (Draft)',
            },
          ],
        };

        mockHttpClient.get.mockResolvedValue(mockResponse);

        const result = await provider.listPullRequests();

        expect(Array.isArray(result)).toBe(true);
        expect(result.length).toBe(2);
        expect(result[0]).toEqual({
          number: 1,
          state: 'open',
          draft: false,
          merged: false,
          mergedAt: null,
          mergedBy: null,
          mergeSha: null,
          url: `https://github.com/${testOwner}/${testRepo}/pull/1`,
          title: 'PR One',
        });
        expect(result[1]).toEqual({
          number: 2,
          state: 'open',
          draft: true,
          merged: false,
          mergedAt: null,
          mergedBy: null,
          mergeSha: null,
          url: `https://github.com/${testOwner}/${testRepo}/pull/2`,
          title: 'PR Two (Draft)',
        });
      });

      it('should map merged PRs correctly with mergedAt, mergedBy, mergeSha', async () => {
        const mergedAt = '2024-01-15T10:30:00Z';
        const mockResponse = {
          data: [
            {
              number: 1,
              state: 'closed',
              draft: false,
              merged: true,
              merged_at: mergedAt,
              merged_by: { login: 'octocat' },
              merge_commit_sha: 'sha123abc',
              html_url: `https://github.com/${testOwner}/${testRepo}/pull/1`,
              title: 'Merged PR',
            },
          ],
        };

        mockHttpClient.get.mockResolvedValue(mockResponse);

        const result = await provider.listPullRequests('closed');

        expect(result[0]).toEqual({
          number: 1,
          state: 'closed',
          draft: false,
          merged: true,
          mergedAt: new Date(mergedAt),
          mergedBy: 'octocat',
          mergeSha: 'sha123abc',
          url: `https://github.com/${testOwner}/${testRepo}/pull/1`,
          title: 'Merged PR',
        });
      });

      it('should handle empty PR list', async () => {
        mockHttpClient.get.mockResolvedValue({ data: [] });

        const result = await provider.listPullRequests();

        expect(Array.isArray(result)).toBe(true);
        expect(result.length).toBe(0);
      });
    });

    describe('authorization header', () => {
      it('should include Authorization Bearer header with token', async () => {
        mockHttpClient.get.mockResolvedValue({ data: [] });

        await provider.listPullRequests();

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
});
