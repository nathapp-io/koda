import { ValidationAppException } from '@nathapp/nestjs-common';
import { createVcsProvider, VcsProviderConfig } from './factory';
import { GitHubProvider } from './providers/github.provider';
import { IVcsProvider } from './vcs-provider';

describe('createVcsProvider factory', () => {
  const validConfig: VcsProviderConfig = {
    provider: 'github',
    token: 'test-token',
    repoUrl: 'https://github.com/owner/repo',
  };

  describe('GitHub provider creation', () => {
    it('should return a GitHubProvider instance when provider type is "github"', () => {
      const provider = createVcsProvider('github', validConfig);

      expect(provider).toBeInstanceOf(GitHubProvider);
      expect(provider).toBeDefined();
    });

    it('should return an IVcsProvider when provider type is "github"', () => {
      const provider = createVcsProvider('github', validConfig);

      expect(provider).toBeDefined();
      expect(typeof provider.fetchIssues).toBe('function');
      expect(typeof provider.fetchIssue).toBe('function');
      expect(typeof provider.testConnection).toBe('function');
    });

    it('should handle "github" in different cases', () => {
      const testCases = ['github', 'GITHUB', 'GitHub', 'GiThUb'];

      testCases.forEach((providerType) => {
        const provider = createVcsProvider(providerType, validConfig);
        expect(provider).toBeInstanceOf(GitHubProvider);
      });
    });

    it('should throw ValidationAppException when repo URL is invalid', () => {
      const invalidConfig: VcsProviderConfig = {
        provider: 'github',
        token: 'test-token',
        repoUrl: 'https://invalid-url.com/repo',
      };

      expect(() => createVcsProvider('github', invalidConfig)).toThrow(
        ValidationAppException,
      );
    });

    it('should throw ValidationAppException for invalid repo URL format', () => {
      const invalidConfig: VcsProviderConfig = {
        provider: 'github',
        token: 'test-token',
        repoUrl: 'not-a-valid-url',
      };

      expect(() => createVcsProvider('github', invalidConfig)).toThrow(
        ValidationAppException,
      );
    });

    it('should throw ValidationAppException when repoUrl is missing owner', () => {
      const invalidConfig: VcsProviderConfig = {
        provider: 'github',
        token: 'test-token',
        repoUrl: 'https://github.com/repo',
      };

      expect(() => createVcsProvider('github', invalidConfig)).toThrow(
        ValidationAppException,
      );
    });

    it('should throw ValidationAppException when repoUrl is missing repo name', () => {
      const invalidConfig: VcsProviderConfig = {
        provider: 'github',
        token: 'test-token',
        repoUrl: 'https://github.com/owner',
      };

      expect(() => createVcsProvider('github', invalidConfig)).toThrow(
        ValidationAppException,
      );
    });
  });

  describe('Unsupported provider handling', () => {
    it('should throw ValidationAppException for "gitlab" provider type', () => {
      expect(() => createVcsProvider('gitlab', validConfig)).toThrow(
        ValidationAppException,
      );
    });

    it('should throw ValidationAppException for gitlab provider', () => {
      expect(() => createVcsProvider('gitlab', validConfig)).toThrow(
        ValidationAppException,
      );
    });

    it('should throw ValidationAppException for unrecognized provider types', () => {
      const unrecognizedProviders = ['bitbucket', 'gitea', 'unknown', 'xyz'];

      unrecognizedProviders.forEach((provider) => {
        expect(() => createVcsProvider(provider, validConfig)).toThrow(
          ValidationAppException,
        );
      });
    });

    it('should throw ValidationAppException for unrecognized providers', () => {
      expect(() => createVcsProvider('bitbucket', validConfig)).toThrow(
        ValidationAppException,
      );
    });
  });

  describe('Invalid input handling', () => {
    it('should throw ValidationAppException when providerType is null', () => {
      expect(() => createVcsProvider(null, validConfig)).toThrow(
        ValidationAppException,
      );
    });

    it('should throw ValidationAppException when providerType is undefined', () => {
      expect(() => createVcsProvider(undefined, validConfig)).toThrow(
        ValidationAppException,
      );
    });

    it('should throw ValidationAppException when providerType is empty string', () => {
      expect(() => createVcsProvider('', validConfig)).toThrow(
        ValidationAppException,
      );
    });

    it('should throw ValidationAppException when providerType is not a string', () => {
      expect(() =>
        createVcsProvider(123 as unknown as string, validConfig),
      ).toThrow(ValidationAppException);
    });

    it('should throw ValidationAppException for non-string provider type', () => {
      expect(() =>
        createVcsProvider({} as unknown as string, validConfig),
      ).toThrow(ValidationAppException);
    });
  });

  describe('Factory export and usability', () => {
    it('should export createVcsProvider function', () => {
      expect(typeof createVcsProvider).toBe('function');
    });

    it('should be usable as a factory function returning IVcsProvider', () => {
      const provider: IVcsProvider = createVcsProvider(
        'github',
        validConfig,
      );

      expect(provider).toBeDefined();
      expect(typeof provider.fetchIssues).toBe('function');
      expect(typeof provider.fetchIssue).toBe('function');
      expect(typeof provider.testConnection).toBe('function');
    });

    it('should be compatible with sync service expectations', () => {
      // VCS-P1-004: Sync service should be able to use this factory
      const providerType = 'github';
      const config: VcsProviderConfig = {
        provider: providerType,
        token: 'valid-token',
        repoUrl: 'https://github.com/test-owner/test-repo',
      };

      const provider = createVcsProvider(providerType, config);

      // Verify it's an IVcsProvider with all required methods
      expect(provider).toBeDefined();
      expect('fetchIssues' in provider).toBe(true);
      expect('fetchIssue' in provider).toBe(true);
      expect('testConnection' in provider).toBe(true);
    });
  });

  describe('GitHub provider with custom HTTP client', () => {
    it('should accept and use a custom HTTP client in config', () => {
      const mockHttpClient = {
        get: jest.fn(),
        post: jest.fn(),
      };

      const configWithClient: VcsProviderConfig = {
        provider: 'github',
        token: 'test-token',
        repoUrl: 'https://github.com/owner/repo',
        httpClient: mockHttpClient,
      };

      const provider = createVcsProvider('github', configWithClient);

      expect(provider).toBeInstanceOf(GitHubProvider);
      expect(provider).toBeDefined();
    });
  });
});
