// Mock chalk early to prevent ESM issues
jest.mock('chalk', () => ({
  cyan: { bold: (str: string) => str },
  gray: (str: string) => str,
  green: (str: string) => str,
  red: (str: string) => str,
  yellow: (str: string) => str,
}));

// Mock conf before importing
const mockData: Record<string, string> = {};

const mockStore = {
  get: jest.fn((key: string) => mockData[key] || ''),
  set: jest.fn((key: string, value: string) => {
    mockData[key] = value;
  }),
};

jest.mock('conf', () => jest.fn(() => mockStore));

// Mock generated client
jest.mock('../generated', () => ({
  projectsControllerFindBySlug: jest.fn(),
  OpenAPI: { BASE: '', TOKEN: '' },
}));

jest.mock('../generated/core/OpenAPI', () => ({
  OpenAPI: { BASE: '', TOKEN: '' },
}));

// Mock config module
jest.mock('../config', () => ({
  getConfig: jest.fn(() => ({
    apiKey: mockData.apiKey || '',
    apiUrl: mockData.apiUrl || '',
    profiles: {},
  })),
  setConfig: jest.fn(),
  validateApiKey: jest.fn((key: string) => Boolean(key) && key.length >= 10),
  maskApiKey: jest.fn((key: string) => (key.length <= 8 ? '****' : `${key.slice(0, 4)}****`)),
}));

import { initCommand, InitDeps } from './init';

function makeDeps(overrides: Partial<InitDeps> = {}): InitDeps {
  return {
    writeFile: jest.fn().mockResolvedValue(undefined),
    mkdir: jest.fn().mockResolvedValue(undefined),
    fetchProject: jest.fn().mockResolvedValue({ data: { ret: 0, data: { slug: 'koda', name: 'Koda' } } }),
    resolveAuth: jest.fn().mockReturnValue({ apiKey: 'sk-test-key-1234567890', apiUrl: 'http://localhost:3100/api' }),
    cwd: jest.fn().mockReturnValue('/fake/cwd'),
    ...overrides,
  };
}

describe('initCommand', () => {
  let exitSpy: jest.SpyInstance;
  let logSpy: jest.SpyInstance;
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    exitSpy = jest.spyOn(process, 'exit').mockImplementation((() => {}) as any);
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.clearAllMocks();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('AC1: writes { projectSlug } to .koda/config.json', () => {
    it('writes projectSlug to .koda/config.json in cwd without prompting', async () => {
      const deps = makeDeps();

      await initCommand({ project: 'koda' }, deps);

      expect(deps.mkdir).toHaveBeenCalledWith('/fake/cwd/.koda', { recursive: true });
      expect(deps.writeFile).toHaveBeenCalledWith(
        '/fake/cwd/.koda/config.json',
        expect.stringContaining('"projectSlug": "koda"'),
      );

      const written = JSON.parse((deps.writeFile as jest.Mock).mock.calls[0][1] as string);
      expect(written).toEqual({ projectSlug: 'koda' });
    });

    it('RED: when --cwd is provided, writes .koda/config.json under that directory', async () => {
      const deps = makeDeps({ cwd: jest.fn().mockReturnValue('/fake/original-cwd') });

      await initCommand({ project: 'koda', cwd: '/fake/override-cwd' } as any, deps);

      expect(deps.mkdir).toHaveBeenCalledWith('/fake/override-cwd/.koda', { recursive: true });
      expect(deps.writeFile).toHaveBeenCalledWith(
        '/fake/override-cwd/.koda/config.json',
        expect.any(String),
      );
    });
  });

  describe('AC2: exits 0 and prints success message', () => {
    it('exits with code 0 and prints a line containing "✓ Created .koda/config.json"', async () => {
      const deps = makeDeps();

      await initCommand({ project: 'koda' }, deps);

      expect(exitSpy).toHaveBeenCalledWith(0);
      const allOutput = logSpy.mock.calls.flat().join('\n');
      expect(allOutput).toContain('✓ Created .koda/config.json');
    });
  });

  describe('AC3: idempotent — second run overwrites', () => {
    it('overwrites .koda/config.json when called a second time', async () => {
      const deps = makeDeps();

      await initCommand({ project: 'koda' }, deps);
      await initCommand({ project: 'koda' }, deps);

      // writeFile should have been called twice (overwrite on second run)
      expect((deps.writeFile as jest.Mock).mock.calls).toHaveLength(2);
    });
  });

  describe('AC4: project not found → exits 1', () => {
    it('exits with code 1 and prints "Project not found: nonexistent" when API returns 404', async () => {
      const notFoundError = new Error('Not Found') as Error & { response: { status: number } };
      notFoundError.response = { status: 404 };

      const deps = makeDeps({
        fetchProject: jest.fn().mockRejectedValue(notFoundError),
      });

      await initCommand({ project: 'nonexistent' }, deps);

      expect(exitSpy).toHaveBeenCalledWith(1);
      const allOutput = errorSpy.mock.calls.flat().join('\n');
      expect(allOutput).toContain('Project not found: nonexistent');
    });
  });

  describe('AC5: writes defaults when defaultType and defaultPriority are provided', () => {
    it('writes { projectSlug, defaults: { type, priority } } to .koda/config.json', async () => {
      const deps = makeDeps();

      await initCommand({ project: 'koda', defaultType: 'BUG', defaultPriority: 'HIGH' }, deps);

      expect(deps.writeFile).toHaveBeenCalled();
      const written = JSON.parse((deps.writeFile as jest.Mock).mock.calls[0][1] as string);
      expect(written).toEqual({
        projectSlug: 'koda',
        defaults: { type: 'BUG', priority: 'HIGH' },
      });
    });

    it('omits defaults key when neither defaultType nor defaultPriority is provided', async () => {
      const deps = makeDeps();

      await initCommand({ project: 'koda' }, deps);

      const written = JSON.parse((deps.writeFile as jest.Mock).mock.calls[0][1] as string);
      expect(written).not.toHaveProperty('defaults');
    });
  });

  describe('AC6: no auth → exits 2', () => {
    it('exits with code 2 and prints login hint when no auth is configured', async () => {
      const deps = makeDeps({
        resolveAuth: jest.fn().mockReturnValue({ apiKey: '', apiUrl: 'http://localhost:3100/api' }),
      });

      await initCommand({}, deps);

      expect(exitSpy).toHaveBeenCalledWith(2);
      const allOutput = errorSpy.mock.calls.flat().join('\n');
      expect(allOutput).toContain('Not logged in. Run: koda login --api-key <key>');
    });

    it('exits with code 2 when no project is provided and no auth', async () => {
      const deps = makeDeps({
        resolveAuth: jest.fn().mockReturnValue({ apiKey: '', apiUrl: '' }),
      });

      await initCommand({}, deps);

      expect(exitSpy).toHaveBeenCalledWith(2);
    });
  });

  describe('project validation', () => {
    it('calls fetchProject with correct apiUrl, apiKey, and project slug', async () => {
      const deps = makeDeps();

      await initCommand({ project: 'koda' }, deps);

      expect(deps.fetchProject).toHaveBeenCalledWith(
        'http://localhost:3100/api',
        'sk-test-key-1234567890',
        'koda',
      );
    });

    it('does not write config when fetchProject throws a non-404 error', async () => {
      const serverError = new Error('Server Error') as Error & { response: { status: number } };
      serverError.response = { status: 500 };

      const deps = makeDeps({
        fetchProject: jest.fn().mockRejectedValue(serverError),
      });

      await initCommand({ project: 'koda' }, deps);

      expect(deps.writeFile).not.toHaveBeenCalled();
      expect(exitSpy).toHaveBeenCalledWith(1);
    });
  });
});
