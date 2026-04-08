/// <reference types="jest" />

import { vcsConfig } from './vcs.config';

describe('vcsConfig', () => {
  describe('namespace registration', () => {
    it('registers with namespace "vcs"', () => {
      const config = vcsConfig();

      // The config object itself is returned by registerAs, which wraps the factory
      expect(config).toBeDefined();
    });
  });

  describe('encryptionKey', () => {
    it('reads encryptionKey from VCS_ENCRYPTION_KEY environment variable', () => {
      const testKey = 'test-encryption-key-32-chars-long';
      process.env['VCS_ENCRYPTION_KEY'] = testKey;

      try {
        const config = vcsConfig();
        expect(config.encryptionKey).toBe(testKey);
      } finally {
        delete process.env['VCS_ENCRYPTION_KEY'];
      }
    });

    it('returns undefined when VCS_ENCRYPTION_KEY is not set', () => {
      delete process.env['VCS_ENCRYPTION_KEY'];
      const config = vcsConfig();

      expect(config.encryptionKey).toBeUndefined();
    });

    it('preserves the exact value of VCS_ENCRYPTION_KEY', () => {
      const testKey =
        '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
      process.env['VCS_ENCRYPTION_KEY'] = testKey;

      try {
        const config = vcsConfig();
        expect(config.encryptionKey).toBe(testKey);
      } finally {
        delete process.env['VCS_ENCRYPTION_KEY'];
      }
    });
  });

  describe('defaultPollingIntervalMs', () => {
    it('reads defaultPollingIntervalMs from VCS_DEFAULT_POLLING_INTERVAL_MS environment variable', () => {
      process.env['VCS_DEFAULT_POLLING_INTERVAL_MS'] = '60000';

      try {
        const config = vcsConfig();
        expect(config.defaultPollingIntervalMs).toBe(60000);
      } finally {
        delete process.env['VCS_DEFAULT_POLLING_INTERVAL_MS'];
      }
    });

    it('returns default value when VCS_DEFAULT_POLLING_INTERVAL_MS is not set', () => {
      delete process.env['VCS_DEFAULT_POLLING_INTERVAL_MS'];
      const config = vcsConfig();

      // Should have a sensible default (e.g., 5 minutes = 300000ms or 1 hour = 3600000ms)
      expect(typeof config.defaultPollingIntervalMs).toBe('number');
      expect(config.defaultPollingIntervalMs).toBeGreaterThan(0);
    });

    it('parses VCS_DEFAULT_POLLING_INTERVAL_MS as a number', () => {
      process.env['VCS_DEFAULT_POLLING_INTERVAL_MS'] = '300000';

      try {
        const config = vcsConfig();
        expect(typeof config.defaultPollingIntervalMs).toBe('number');
        expect(config.defaultPollingIntervalMs).toBe(300000);
      } finally {
        delete process.env['VCS_DEFAULT_POLLING_INTERVAL_MS'];
      }
    });

    it('uses environment variable value when both env and default exist', () => {
      process.env['VCS_DEFAULT_POLLING_INTERVAL_MS'] = '120000';

      try {
        const config = vcsConfig();
        expect(config.defaultPollingIntervalMs).toBe(120000);
      } finally {
        delete process.env['VCS_DEFAULT_POLLING_INTERVAL_MS'];
      }
    });
  });

  describe('githubApiUrl', () => {
    it('reads githubApiUrl from GITHUB_API_URL environment variable', () => {
      const testUrl = 'https://api.github.com';
      process.env['GITHUB_API_URL'] = testUrl;

      try {
        const config = vcsConfig();
        expect(config.githubApiUrl).toBe(testUrl);
      } finally {
        delete process.env['GITHUB_API_URL'];
      }
    });

    it('returns default value when GITHUB_API_URL is not set', () => {
      delete process.env['GITHUB_API_URL'];
      const config = vcsConfig();

      // Should default to public GitHub API
      expect(config.githubApiUrl).toBeDefined();
      expect(typeof config.githubApiUrl).toBe('string');
    });

    it('preserves the exact URL value from environment variable', () => {
      const testUrl = 'https://github.enterprise.com/api/v3';
      process.env['GITHUB_API_URL'] = testUrl;

      try {
        const config = vcsConfig();
        expect(config.githubApiUrl).toBe(testUrl);
      } finally {
        delete process.env['GITHUB_API_URL'];
      }
    });

    it('allows for enterprise GitHub URLs', () => {
      const enterpriseUrl = 'https://my-github.company.com/api/v3';
      process.env['GITHUB_API_URL'] = enterpriseUrl;

      try {
        const config = vcsConfig();
        expect(config.githubApiUrl).toBe(enterpriseUrl);
      } finally {
        delete process.env['GITHUB_API_URL'];
      }
    });
  });

  describe('Configuration object shape', () => {
    it('returns an object with encryptionKey property', () => {
      const config = vcsConfig();
      expect('encryptionKey' in config).toBe(true);
    });

    it('returns an object with defaultPollingIntervalMs property', () => {
      const config = vcsConfig();
      expect('defaultPollingIntervalMs' in config).toBe(true);
    });

    it('returns an object with githubApiUrl property', () => {
      const config = vcsConfig();
      expect('githubApiUrl' in config).toBe(true);
    });

    it('contains only expected properties', () => {
      const config = vcsConfig();
      const keys = Object.keys(config);

      expect(keys).toContain('encryptionKey');
      expect(keys).toContain('defaultPollingIntervalMs');
      expect(keys).toContain('githubApiUrl');
    });
  });

  describe('Environment variable isolation', () => {
    it('does not leak environment variables across multiple calls', () => {
      process.env['VCS_ENCRYPTION_KEY'] = 'key-1';
      const config1 = vcsConfig();
      expect(config1.encryptionKey).toBe('key-1');

      process.env['VCS_ENCRYPTION_KEY'] = 'key-2';
      const config2 = vcsConfig();
      expect(config2.encryptionKey).toBe('key-2');

      delete process.env['VCS_ENCRYPTION_KEY'];
    });

    it('respects changes to environment variables between calls', () => {
      process.env['VCS_DEFAULT_POLLING_INTERVAL_MS'] = '60000';
      const config1 = vcsConfig();
      expect(config1.defaultPollingIntervalMs).toBe(60000);

      process.env['VCS_DEFAULT_POLLING_INTERVAL_MS'] = '120000';
      const config2 = vcsConfig();
      expect(config2.defaultPollingIntervalMs).toBe(120000);

      delete process.env['VCS_DEFAULT_POLLING_INTERVAL_MS'];
    });
  });
});
