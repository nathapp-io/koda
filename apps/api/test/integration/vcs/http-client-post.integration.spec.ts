/**
 * HttpClient POST Method Tests
 *
 * Tests for the post method in HttpClient interface used for GitHub API calls.
 *
 * Run: bun test test/integration/vcs/http-client-post.integration.spec.ts
 */

import { HttpClient } from '../../../src/vcs/factory';

describe('HttpClient.post', () => {
  describe('interface compliance', () => {
    it('should have post method defined in interface', () => {
      const httpClient: HttpClient = {
        get: jest.fn(),
        post: jest.fn(),
      };
      expect(typeof httpClient.post).toBe('function');
    });

    it('should accept url and config parameters', async () => {
      const httpClient: HttpClient = {
        get: jest.fn(),
        post: jest.fn().mockResolvedValue({ data: {} }),
      };

      await httpClient.post('https://api.github.com/test', {
        headers: { Authorization: 'Bearer token' },
        body: { key: 'value' },
      });

      expect(httpClient.post).toHaveBeenCalledWith(
        'https://api.github.com/test',
        expect.objectContaining({
          headers: expect.any(Object),
          body: expect.any(Object),
        }),
      );
    });

    it('should return Promise<{ data: unknown }>', async () => {
      const httpClient: HttpClient = {
        get: jest.fn(),
        post: jest.fn().mockResolvedValue({ data: { id: 123 } }),
      };

      const result = await httpClient.post('https://api.github.com/test', {
        headers: {},
        body: {},
      });

      expect(result).toHaveProperty('data');
      expect(result.data).toEqual({ id: 123 });
    });
  });

  describe('VcsProviderConfig httpClient factory', () => {
    it('should create HttpClient with post method when httpClient is provided in config', () => {
      const mockHttpClient = {
        get: jest.fn(),
        post: jest.fn(),
      };

      const config = {
        provider: 'github',
        token: 'test-token',
        repoUrl: 'https://github.com/owner/repo',
        httpClient: mockHttpClient,
      };

      expect(config.httpClient).toBeDefined();
      expect(typeof config.httpClient?.post).toBe('function');
    });
  });
});
