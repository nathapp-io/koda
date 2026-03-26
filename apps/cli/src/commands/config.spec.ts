// Mock conf before importing anything
const mockData: Record<string, string> = {};

const mockStore = {
  get: jest.fn((key: string) => mockData[key] || ''),
  set: jest.fn((key: string, value: string) => {
    mockData[key] = value;
  }),
};

jest.mock('conf', () => {
  return jest.fn(() => mockStore);
});

// Shared mock profiles store for profile tests
const mockProfiles: Record<string, { apiUrl: string; apiKey: string }> = {};

// Mock config module to use mockData
jest.mock('../config', () => ({
  getConfig: jest.fn(() => ({
    apiKey: mockData.apiKey || '',
    apiUrl: mockData.apiUrl || '',
  })),
  setConfig: jest.fn((partial: any) => {
    if (partial.apiKey !== undefined) {
      if (!partial.apiKey || typeof partial.apiKey !== 'string' || partial.apiKey.length < 10) {
        throw new Error('Invalid API key: must be at least 10 characters');
      }
      mockData.apiKey = partial.apiKey;
      mockStore.set('apiKey', partial.apiKey);
    }
    if (partial.apiUrl !== undefined) {
      mockData.apiUrl = partial.apiUrl;
      mockStore.set('apiUrl', partial.apiUrl);
    }
  }),
  validateApiKey: jest.fn((key: string) => key && key.length >= 10),
  maskApiKey: jest.fn((key: string) => {
    if (!key || key.length < 4) {
      return '****';
    }
    if (key.startsWith('sk-proj-')) {
      const prefix = 'sk-proj-';
      const rest = key.slice(prefix.length);
      const masked = '*'.repeat(Math.max(4, rest.length));
      return `${prefix}${masked}`;
    }
    const visible = key.slice(-6);
    return `***${visible}`;
  }),
  getProfiles: jest.fn(() =>
    Object.entries(mockProfiles).map(([name, p]) => ({ name, apiUrl: p.apiUrl })),
  ),
  setProfile: jest.fn((name: string, profile: { apiUrl: string; apiKey: string }) => {
    mockProfiles[name] = profile;
  }),
  removeProfile: jest.fn((name: string) => {
    if (!(name in mockProfiles)) {
      throw new Error(`Profile not found: ${name}`);
    }
    delete mockProfiles[name];
  }),
}));

import {
  configShow,
  configSet,
  configProfileList,
  configProfileListAction,
  configProfileRemoveAction,
  type ConfigProfileActionDeps,
} from './config';

describe('config command', () => {
  beforeEach(() => {
    Object.keys(mockData).forEach((key) => {
      delete mockData[key];
    });
    jest.clearAllMocks();
    mockData.apiKey = 'sk-proj-test123456';
    mockData.apiUrl = 'http://example.com';
  });

  describe('configShow', () => {
    it('returns config object with masked API key', () => {
      const result = configShow();
      expect(result).toEqual(
        expect.objectContaining({
          apiKey: expect.stringMatching(/^sk-proj-\*+$/),
          apiUrl: 'http://example.com',
        })
      );
    });

    it('displays API key prefix in masked version', () => {
      const result = configShow();
      const maskedKey = result.apiKey;
      expect(maskedKey).toMatch(/^sk-proj-\*+/);
    });

    it('returns empty string for apiUrl when not set', () => {
      mockData.apiUrl = '';
      const result = configShow();
      expect(result.apiUrl).toBe('');
    });

    it('masks API key with first 8 chars visible', () => {
      mockData.apiKey = 'sk-proj-verylongapikey1234567890';
      const result = configShow();
      expect(result.apiKey).toMatch(/^sk-proj-\*+/);
    });
  });

  describe('configSet', () => {
    it('updates API key when provided', () => {
      configSet({ apiKey: 'sk-proj-newkey123456' });
      expect(mockStore.set).toHaveBeenCalledWith('apiKey', 'sk-proj-newkey123456');
    });

    it('updates API URL when provided', () => {
      configSet({ apiUrl: 'http://newapi.com' });
      expect(mockStore.set).toHaveBeenCalledWith('apiUrl', 'http://newapi.com');
    });

    it('updates both when both provided', () => {
      configSet({
        apiKey: 'sk-proj-newkey123456',
        apiUrl: 'http://newapi.com',
      });
      expect(mockStore.set).toHaveBeenCalledWith('apiKey', 'sk-proj-newkey123456');
      expect(mockStore.set).toHaveBeenCalledWith('apiUrl', 'http://newapi.com');
    });

    it('throws error when API key is invalid', () => {
      expect(() => {
        configSet({ apiKey: 'invalid' });
      }).toThrow();
    });

    it('returns success message', () => {
      const result = configSet({ apiKey: 'sk-proj-newkey123456' });
      expect(result).toEqual(expect.objectContaining({ success: true }));
    });
  });
});

describe('configProfileList', () => {
  beforeEach(() => {
    Object.keys(mockProfiles).forEach((k) => delete mockProfiles[k]);
    jest.clearAllMocks();
  });

  it('AC2: returns array of { name, apiUrl } entries for each stored profile', () => {
    mockProfiles.staging = { apiUrl: 'https://staging.koda.io/api', apiKey: 'stg-xxx' };
    mockProfiles.prod = { apiUrl: 'https://prod.koda.io/api', apiKey: 'prod-yyy' };
    const result = configProfileList();
    expect(result).toHaveLength(2);
    expect(result).toEqual(
      expect.arrayContaining([
        { name: 'staging', apiUrl: 'https://staging.koda.io/api' },
        { name: 'prod', apiUrl: 'https://prod.koda.io/api' },
      ]),
    );
  });

  it('AC3: returns empty array when profiles is empty', () => {
    const result = configProfileList();
    expect(result).toEqual([]);
  });
});

describe('configProfileListAction', () => {
  let exitSpy: jest.SpyInstance;
  let logSpy: jest.SpyInstance;

  function makeDeps(profiles: Array<{ name: string; apiUrl: string }>): ConfigProfileActionDeps {
    return {
      getProfiles: jest.fn(() => profiles),
      setProfile: jest.fn(),
      removeProfile: jest.fn(),
    };
  }

  beforeEach(() => {
    exitSpy = jest.spyOn(process, 'exit').mockImplementation((() => {}) as any);
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('AC7: prints Name and ApiUrl for each profile and exits with code 0', () => {
    const deps = makeDeps([{ name: 'staging', apiUrl: 'https://staging.koda.io/api' }]);
    configProfileListAction(deps);
    expect(exitSpy).toHaveBeenCalledWith(0);
    const output = logSpy.mock.calls.flat().join('\n');
    expect(output).toContain('staging');
    expect(output).toContain('https://staging.koda.io/api');
  });

  it('AC8: prints "No profiles configured" and exits with code 0 when no profiles exist', () => {
    const deps = makeDeps([]);
    configProfileListAction(deps);
    expect(exitSpy).toHaveBeenCalledWith(0);
    const output = logSpy.mock.calls.flat().join('\n');
    expect(output).toContain('No profiles configured');
  });
});

describe('configProfileRemoveAction', () => {
  let exitSpy: jest.SpyInstance;
  let errorSpy: jest.SpyInstance;

  function makeDeps(removeImpl: (name: string) => void): ConfigProfileActionDeps {
    return {
      getProfiles: jest.fn(() => []),
      setProfile: jest.fn(),
      removeProfile: jest.fn(removeImpl),
    };
  }

  beforeEach(() => {
    exitSpy = jest.spyOn(process, 'exit').mockImplementation((() => {}) as any);
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('AC9: exits with code 1 and prints "Profile not found: nonexistent" for missing profile', () => {
    const deps = makeDeps(() => {
      throw new Error('Profile not found: nonexistent');
    });
    configProfileRemoveAction('nonexistent', deps);
    expect(exitSpy).toHaveBeenCalledWith(1);
    const output = errorSpy.mock.calls.flat().join('\n');
    expect(output).toContain('Profile not found: nonexistent');
  });
});
