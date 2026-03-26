// Mock conf before importing config module
const mockData: Record<string, unknown> = {};

const mockStore = {
  get: jest.fn((key: string) => {
    if (key in mockData) return mockData[key];
    return key === 'profiles' ? {} : '';
  }),
  set: jest.fn((key: string, value: unknown) => {
    mockData[key] = value;
  }),
};

jest.mock('conf', () => {
  return jest.fn(() => mockStore);
});

import {
  getConfig,
  setConfig,
  validateApiKey,
  maskApiKey,
  findProjectConfig,
  resolveContext,
  _configDeps,
  type Profile,
  type ProjectConfig,
  type ResolveContextDeps,
} from './config';

describe('config', () => {
  beforeEach(() => {
    Object.keys(mockData).forEach((key) => {
      delete mockData[key];
    });
    jest.clearAllMocks();
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

    it('AC4: apiUrl comes from .koda/config.json when specified and no CLI flag overrides it', async () => {
      const deps: ResolveContextDeps = {
        findProjectConfig: makeProjectConfigDep({ projectSlug: 'my-project', apiUrl: 'https://project-level.example.com' }),
        getConfig: makeGlobalConfig({ apiUrl: 'https://global.example.com' }),
      };
      const result = await resolveContext({}, deps);
      expect(result.apiUrl).toBe('https://project-level.example.com');
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
      expect(result.apiUrl).toBe('http://localhost:3100/api');
      expect(result.apiKey).toBe('');
    });
  });
});
