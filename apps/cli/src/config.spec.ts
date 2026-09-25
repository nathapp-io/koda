// Mock conf before importing config module
const mockData: Record<string, unknown> = { profiles: {} };

// Partial mock of 'os': homedir is a jest.fn defaulting to the real home dir
// so H10 tests can simulate an alternate home directory (homedir ceiling).
jest.mock('os', () => {
  const actual = jest.requireActual('os');
  const realHomedir = actual.homedir();
  return { ...actual, homedir: jest.fn(() => realHomedir) };
});

const mockStore = {
  get(key: string) {
    if (key in mockData) return mockData[key];
    return key === 'profiles' ? {} : '';
  },
  set(key: string, value: unknown) {
    mockData[key] = value;
  },
};

jest.mock('conf', () => {
  return jest.fn(() => mockStore);
});

import { homedir } from 'os';
import {
  getConfig,
  setConfig,
  validateApiKey,
  maskApiKey,
  findProjectConfig,
  resolveContext,
  setProfile,
  getProfiles,
  removeProfile,
  _configDeps,
  type Profile,
  type ProjectConfig,
  type ResolveContextDeps,
} from './config';

const KODA_ENV_VARS = ['KODA_API_KEY', 'KODA_API_URL', 'KODA_PROJECT_SLUG'] as const;

describe('config', () => {
  beforeEach(() => {
    Object.keys(mockData).forEach((key) => {
      delete mockData[key];
    });
    mockData.profiles = {};
    // Prevent a developer's or CI's real KODA_* env vars from leaking into resolveContext tests.
    KODA_ENV_VARS.forEach((key) => delete process.env[key]);
  });

  describe('maskApiKey', () => {
    it('masks long API keys showing first 8 chars and asterisks for remaining', () => {
      const result = maskApiKey('sk-proj-test123456abcdef');
      // 24 chars total: first 8 visible, 16 chars masked as asterisks
      expect(result).toMatch(/^sk-proj-\*{16}$/);
    });

    it('shows sk-proj- prefix when masking standard keys', () => {
      const result = maskApiKey('sk-proj-abcdef1234567890');
      expect(result).toMatch(/^sk-proj-\*+$/);
    });

    it('masks with at least 4 asterisks for short keys', () => {
      const result = maskApiKey('sk-proj-test');
      expect(result).toContain('*');
      expect(result.split('*').length - 1).toBeGreaterThanOrEqual(4);
    });

    it('handles very long API keys', () => {
      const longKey = 'sk-proj-' + 'x'.repeat(100);
      const result = maskApiKey(longKey);
      expect(result).toMatch(/^sk-proj-\*+$/);
      expect(result.split('*').length - 1).toBeGreaterThan(4);
    });

    it('returns **** for empty API key', () => {
      const result = maskApiKey('');
      expect(result).toBe('****');
    });

    it('returns **** for very short API key', () => {
      const result = maskApiKey('abc');
      expect(result).toBe('****');
    });

    it('does not leak full API key', () => {
      const apiKey = 'sk-proj-verysecretkey123';
      const result = maskApiKey(apiKey);
      expect(result).not.toContain('verysecretkey123');
    });
  });

  describe('validateApiKey', () => {
    it('returns true for valid API key', () => {
      const result = validateApiKey('sk-proj-abcdef1234567890');
      expect(result).toBe(true);
    });

    it('returns false for empty API key', () => {
      const result = validateApiKey('');
      expect(result).toBe(false);
    });

    it('returns false for API key shorter than 10 characters', () => {
      const result = validateApiKey('short');
      expect(result).toBe(false);
    });

    it('returns false for undefined API key', () => {
      const result = validateApiKey(undefined);
      expect(result).toBe(false);
    });
  });

  describe('getConfig', () => {
    it('returns config object with apiKey and apiUrl', () => {
      const config = getConfig();
      expect(config).toEqual(expect.objectContaining({
        apiKey: expect.any(String),
        apiUrl: expect.any(String),
      }));
    });

    it('returns empty strings for unset values', () => {
      const config = getConfig();
      // Should not throw and should have properties
      expect(config).toHaveProperty('apiKey');
      expect(config).toHaveProperty('apiUrl');
    });
  });

  describe('setConfig', () => {
    it('saves apiKey to config file', () => {
      setConfig({ apiKey: 'sk-proj-test123456' });
      const config = getConfig();
      expect(config.apiKey).toBe('sk-proj-test123456');
    });

    it('saves apiUrl to config file', () => {
      setConfig({ apiUrl: 'http://example.com' });
      const config = getConfig();
      expect(config.apiUrl).toBe('http://example.com');
    });

    it('saves both apiKey and apiUrl', () => {
      setConfig({ apiKey: 'sk-proj-test123456', apiUrl: 'http://example.com' });
      const config = getConfig();
      expect(config.apiKey).toBe('sk-proj-test123456');
      expect(config.apiUrl).toBe('http://example.com');
    });

    it('updates only specified fields', () => {
      setConfig({ apiKey: 'sk-proj-initial' });
      setConfig({ apiUrl: 'http://new-url.com' });
      const config = getConfig();
      expect(config.apiKey).toBe('sk-proj-initial');
      expect(config.apiUrl).toBe('http://new-url.com');
    });

    it('throws error for invalid API key', () => {
      expect(() => {
        setConfig({ apiKey: 'invalid' });
      }).toThrow();
    });

    it('throws error for empty API key when trying to set', () => {
      expect(() => {
        setConfig({ apiKey: '' });
      }).toThrow();
    });
  });

  describe('findProjectConfig', () => {
    it('returns ProjectConfig when .koda/config.json exists in starting directory', async () => {
      const mockReadFile = jest.fn(async (path: string) => {
        if (path === '/a/b/c/.koda/config.json') {
          return JSON.stringify({ projectSlug: 'my-project' });
        }
        throw new Error('ENOENT');
      });

      const mockExists = jest.fn(async (path: string) => {
        return path === '/a/b/c/.koda/config.json';
      });

      const result = await findProjectConfig('/a/b/c', { readFile: mockReadFile, exists: mockExists });
      expect(result).toEqual({ projectSlug: 'my-project' });
    });

    it('returns ProjectConfig by walking up to ancestor directory', async () => {
      const mockReadFile = jest.fn(async (path: string) => {
        if (path === '/a/.koda/config.json') {
          return JSON.stringify({ projectSlug: 'ancestor-project' });
        }
        throw new Error('ENOENT');
      });

      const mockExists = jest.fn(async (path: string) => {
        return path === '/a/.koda/config.json';
      });

      const result = await findProjectConfig('/a/b/c', { readFile: mockReadFile, exists: mockExists });
      expect(result).toEqual({ projectSlug: 'ancestor-project' });
    });

    it('returns null when no .koda/config.json exists at any ancestor', async () => {
      const mockReadFile = jest.fn(async (path: string) => {
        throw new Error('ENOENT');
      });

      const mockExists = jest.fn(async (path: string) => {
        return false;
      });

      const result = await findProjectConfig('/a/b/c', { readFile: mockReadFile, exists: mockExists });
      expect(result).toBeNull();
    });

    it('uses process.cwd() when no directory argument provided', async () => {
      const originalCwd = process.cwd();
      const mockReadFile = jest.fn(async (path: string) => {
        if (path.endsWith('.koda/config.json')) {
          return JSON.stringify({ projectSlug: 'test-project' });
        }
        throw new Error('ENOENT');
      });

      const mockExists = jest.fn(async (path: string) => {
        return path.endsWith('.koda/config.json');
      });

      const result = await findProjectConfig(undefined, { readFile: mockReadFile, exists: mockExists });
      expect(result).toEqual({ projectSlug: 'test-project' });
    });

    it('H10: never returns ~/.koda/config.json — walk stops at the homedir ceiling', async () => {
      // Simulate a home directory at /a so that /a/.koda/config.json is the
      // "global" config. The walk starts below it (/a/b/c) and must stop
      // before considering /a itself.
      const homedirMock = homedir as unknown as jest.Mock;
      homedirMock.mockReturnValue('/a');

      const mockReadFile = jest.fn(async (path: string) => {
        if (path === '/a/.koda/config.json') {
          return JSON.stringify({ projectSlug: 'global-not-project' });
        }
        throw new Error('ENOENT');
      });

      const mockExists = jest.fn(async (path: string) => {
        return path === '/a/.koda/config.json';
      });

      try {
        const result = await findProjectConfig('/a/b/c', { readFile: mockReadFile, exists: mockExists });
        expect(result).toBeNull();
        expect(mockReadFile).not.toHaveBeenCalledWith('/a/.koda/config.json');
      } finally {
        homedirMock.mockClear();
      }
    });

    it('H10: returns null when the starting directory is the home directory itself', async () => {
      const homedirMock = homedir as unknown as jest.Mock;
      homedirMock.mockReturnValue('/a');

      const mockReadFile = jest.fn(async () => {
        throw new Error('ENOENT');
      });

      const mockExists = jest.fn(async () => false);

      try {
        const result = await findProjectConfig('/a', { readFile: mockReadFile, exists: mockExists });
        expect(result).toBeNull();
      } finally {
        homedirMock.mockClear();
      }
    });

    it('returns null when .koda/config.json contains invalid JSON', async () => {
      const mockReadFile = jest.fn(async (path: string) => {
        if (path === '/a/b/c/.koda/config.json') {
          return 'invalid json {';
        }
        throw new Error('ENOENT');
      });

      const mockExists = jest.fn(async (path: string) => {
        return path === '/a/b/c/.koda/config.json';
      });

      const result = await findProjectConfig('/a/b/c', { readFile: mockReadFile, exists: mockExists });
      expect(result).toBeNull();
    });

    it('returns ProjectConfig with projectSlug field', async () => {
      const mockReadFile = jest.fn(async (path: string) => {
        if (path === '/a/b/c/.koda/config.json') {
          return JSON.stringify({ projectSlug: 'my-project', otherField: 'value' });
        }
        throw new Error('ENOENT');
      });

      const mockExists = jest.fn(async (path: string) => {
        return path === '/a/b/c/.koda/config.json';
      });

      const result = await findProjectConfig('/a/b/c', { readFile: mockReadFile, exists: mockExists });
      expect(result?.projectSlug).toBe('my-project');
    });
  });

  describe('setProfile', () => {
    it('AC1: writes { apiUrl, apiKey } under profiles.<name> in the global config store', () => {
      setProfile('staging', { apiUrl: 'https://staging.koda.io/api', apiKey: 'stg-xxx' });
      const storedProfiles = mockStore.get('profiles') as Record<string, Profile>;
      expect(storedProfiles).toHaveProperty('staging');
      expect(storedProfiles.staging).toEqual({
        apiUrl: 'https://staging.koda.io/api',
        apiKey: 'stg-xxx',
      });
    });

    it('AC6: calling setProfile twice with different apiKey stores only the second value', () => {
      setProfile('staging', { apiUrl: 'https://staging.koda.io/api', apiKey: 'old-key' });
      setProfile('staging', { apiUrl: 'https://staging.koda.io/api', apiKey: 'new-key' });
      const storedProfiles = mockStore.get('profiles') as Record<string, Profile>;
      expect(storedProfiles.staging.apiKey).toBe('new-key');
    });

    it('does not overwrite other profiles when adding a new one', () => {
      mockData.profiles = { prod: { apiUrl: 'https://prod.koda.io/api', apiKey: 'prod-key' } };
      setProfile('staging', { apiUrl: 'https://staging.koda.io/api', apiKey: 'stg-key' });
      const storedProfiles = mockStore.get('profiles') as Record<string, Profile>;
      expect(storedProfiles).toHaveProperty('prod');
      expect(storedProfiles).toHaveProperty('staging');
    });
  });

  describe('getProfiles', () => {
    it('AC2: returns array of { name, apiUrl } entries for each stored profile', () => {
      mockData.profiles = {
        staging: { apiUrl: 'https://staging.koda.io/api', apiKey: 'stg-xxx' },
        prod: { apiUrl: 'https://prod.koda.io/api', apiKey: 'prod-yyy' },
      };
      const result = getProfiles();
      expect(result).toHaveLength(2);
      expect(result).toEqual(
        expect.arrayContaining([
          { name: 'staging', apiUrl: 'https://staging.koda.io/api' },
          { name: 'prod', apiUrl: 'https://prod.koda.io/api' },
        ]),
      );
    });

    it('AC3: returns empty array when profiles is empty', () => {
      mockData.profiles = {};
      const result = getProfiles();
      expect(result).toEqual([]);
    });

    it('AC3: returns empty array when profiles key is absent', () => {
      // no mockData.profiles set — mockStore.get returns {} for 'profiles'
      const result = getProfiles();
      expect(result).toEqual([]);
    });

    it('does not include apiKey in returned entries', () => {
      mockData.profiles = {
        staging: { apiUrl: 'https://staging.koda.io/api', apiKey: 'secret-key' },
      };
      const result = getProfiles();
      expect(result[0]).not.toHaveProperty('apiKey');
    });
  });

  describe('removeProfile', () => {
    it('AC4: removes profiles.<name> from the global config store', () => {
      mockData.profiles = {
        staging: { apiUrl: 'https://staging.koda.io/api', apiKey: 'stg-xxx' },
      };
      removeProfile('staging');
      const storedProfiles = mockStore.get('profiles') as Record<string, Profile>;
      expect(storedProfiles).not.toHaveProperty('staging');
    });

    it('AC4: returns without error when profile exists', () => {
      mockData.profiles = {
        staging: { apiUrl: 'https://staging.koda.io/api', apiKey: 'stg-xxx' },
      };
      expect(() => removeProfile('staging')).not.toThrow();
    });

    it('AC5: throws error containing "Profile not found: nonexistent" for missing profile', () => {
      mockData.profiles = {};
      expect(() => removeProfile('nonexistent')).toThrow('Profile not found: nonexistent');
    });

    it('does not affect other profiles when removing one', () => {
      mockData.profiles = {
        staging: { apiUrl: 'https://staging.koda.io/api', apiKey: 'stg-xxx' },
        prod: { apiUrl: 'https://prod.koda.io/api', apiKey: 'prod-yyy' },
      };
      removeProfile('staging');
      const storedProfiles = mockStore.get('profiles') as Record<string, Profile>;
      expect(storedProfiles).toHaveProperty('prod');
    });
  });

  describe('resolveContext', () => {
    function makeProjectConfigDep(config: ProjectConfig | null): ResolveContextDeps['findProjectConfig'] {
      return jest.fn(async () => config);
    }

    function makeGlobalConfig(overrides: Partial<{ apiKey: string; apiUrl: string; profiles: Record<string, Profile> }>): ResolveContextDeps['getConfig'] {
      return jest.fn(() => ({
        apiKey: overrides.apiKey ?? '',
        apiUrl: overrides.apiUrl ?? '',
        profiles: overrides.profiles ?? {},
      }));
    }

    it('AC1: flag projectSlug overrides project config', async () => {
      const deps: ResolveContextDeps = {
        findProjectConfig: makeProjectConfigDep({ projectSlug: 'from-config' }),
        getConfig: makeGlobalConfig({}),
      };
      const result = await resolveContext({ projectSlug: 'override' }, deps);
      expect(result.projectSlug).toBe('override');
    });

    it('AC2: projectSlug comes from .koda/config.json when no flag provided', async () => {
      const deps: ResolveContextDeps = {
        findProjectConfig: makeProjectConfigDep({ projectSlug: 'from-project-config' }),
        getConfig: makeGlobalConfig({}),
      };
      const result = await resolveContext({}, deps);
      expect(result.projectSlug).toBe('from-project-config');
    });

    it('AC3: apiUrl and apiKey come from named profile when .koda/config.json has profile field', async () => {
      const stagingProfile: Profile = { apiKey: 'staging-key-abcdef', apiUrl: 'https://staging.example.com' };
      const deps: ResolveContextDeps = {
        findProjectConfig: makeProjectConfigDep({ projectSlug: 'my-project', profile: 'staging' }),
        getConfig: makeGlobalConfig({ profiles: { staging: stagingProfile } }),
      };
      const result = await resolveContext({}, deps);
      expect(result.apiUrl).toBe('https://staging.example.com');
      expect(result.apiKey).toBe('staging-key-abcdef');
    });

    it('H10: project config apiUrl is ignored with a warning', async () => {
      const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
      try {
        const deps: ResolveContextDeps = {
          findProjectConfig: makeProjectConfigDep({ projectSlug: 'p', apiUrl: 'https://evil' }),
          getConfig: makeGlobalConfig({ apiUrl: 'http://localhost:3100', apiKey: 'real-key' }),
        };
        const result = await resolveContext({}, deps);
        expect(result.apiUrl).toBe('http://localhost:3100');
        expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('ignored'));
        expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('security'));
      } finally {
        errorSpy.mockRestore();
      }
    });

    it('H10: project config apiKey is ignored', async () => {
      const deps: ResolveContextDeps = {
        findProjectConfig: makeProjectConfigDep({ projectSlug: 'p', apiKey: 'stolen' }),
        getConfig: makeGlobalConfig({ apiUrl: 'http://localhost:3100', apiKey: 'real-key' }),
      };
      const result = await resolveContext({}, deps);
      expect(result.apiKey).toBe('real-key');
    });

    it('H10: profile apiUrl and apiKey are still honored (positive control)', async () => {
      const stagingProfile: Profile = { apiKey: 'profile-key-abcdef', apiUrl: 'https://profile.example.com' };
      const deps: ResolveContextDeps = {
        findProjectConfig: makeProjectConfigDep({ projectSlug: 'p', profile: 'staging' }),
        getConfig: makeGlobalConfig({ profiles: { staging: stagingProfile } }),
      };
      const result = await resolveContext({}, deps);
      expect(result.apiUrl).toBe('https://profile.example.com');
      expect(result.apiKey).toBe('profile-key-abcdef');
    });

    it('H10: apiUrl falls back to global config when .koda/config.json specifies apiUrl (project apiUrl ignored)', async () => {
      const deps: ResolveContextDeps = {
        findProjectConfig: makeProjectConfigDep({ projectSlug: 'my-project', apiUrl: 'https://project-level.example.com' }),
        getConfig: makeGlobalConfig({ apiUrl: 'https://global.example.com' }),
      };
      const result = await resolveContext({}, deps);
      expect(result.apiUrl).toBe('https://global.example.com');
    });

    it('AC5: apiKey comes from global conf store when .koda/config.json has no profile field', async () => {
      const deps: ResolveContextDeps = {
        findProjectConfig: makeProjectConfigDep({ projectSlug: 'my-project' }),
        getConfig: makeGlobalConfig({ apiKey: 'global-key-abcdefghij' }),
      };
      const result = await resolveContext({}, deps);
      expect(result.apiKey).toBe('global-key-abcdefghij');
    });

    it('AC6: returns built-in defaults when no .koda/config.json and global conf store is empty', async () => {
      const deps: ResolveContextDeps = {
        findProjectConfig: makeProjectConfigDep(null),
        getConfig: makeGlobalConfig({}),
      };
      const result = await resolveContext({}, deps);
      expect(result.apiUrl).toBe('http://localhost:3100');
      expect(result.apiKey).toBe('');
    });

    it('passes cwd override to findProjectConfig when provided', async () => {
      const findProjectConfig = jest.fn(async () => ({ projectSlug: 'from-cwd' }));
      const deps: ResolveContextDeps = {
        findProjectConfig,
        getConfig: makeGlobalConfig({ apiKey: 'global-key-123456' }),
      };

      await resolveContext({ cwd: '/repo/feature-dir' }, deps);

      expect(findProjectConfig).toHaveBeenCalledWith('/repo/feature-dir');
    });

    describe('env var overrides', () => {
      afterEach(() => {
        KODA_ENV_VARS.forEach((key) => delete process.env[key]);
      });

      it('KODA_API_KEY and KODA_API_URL env vars are honored when no flag is provided', async () => {
        process.env.KODA_API_KEY = 'env-key-abcdefghij';
        process.env.KODA_API_URL = 'https://env.example.com';

        const deps: ResolveContextDeps = {
          findProjectConfig: makeProjectConfigDep({ projectSlug: 'my-project' }),
          getConfig: makeGlobalConfig({ apiKey: 'global-key-abcdefghij', apiUrl: 'https://global.example.com' }),
        };

        const result = await resolveContext({}, deps);
        expect(result.apiKey).toBe('env-key-abcdefghij');
        expect(result.apiUrl).toBe('https://env.example.com');
      });

      it('explicit flags still take precedence over env vars', async () => {
        process.env.KODA_API_KEY = 'env-key-abcdefghij';
        process.env.KODA_API_URL = 'https://env.example.com';

        const deps: ResolveContextDeps = {
          findProjectConfig: makeProjectConfigDep(null),
          getConfig: makeGlobalConfig({}),
        };

        const result = await resolveContext({ apiKey: 'flag-key-abcdefghij', apiUrl: 'https://flag.example.com' }, deps);
        expect(result.apiKey).toBe('flag-key-abcdefghij');
        expect(result.apiUrl).toBe('https://flag.example.com');
      });

      it('KODA_PROJECT_SLUG env var is honored when no flag or project config provides one', async () => {
        process.env.KODA_PROJECT_SLUG = 'env-project';

        const deps: ResolveContextDeps = {
          findProjectConfig: makeProjectConfigDep(null),
          getConfig: makeGlobalConfig({}),
        };

        const result = await resolveContext({}, deps);
        expect(result.projectSlug).toBe('env-project');
      });
    });
  });
});
