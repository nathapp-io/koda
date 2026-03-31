// Mock chalk early to prevent ESM issues
jest.mock('chalk', () => {
  const mockChalk = {
    cyan: { bold: (str: string) => str },
    gray: (str: string) => str,
    green: (str: string) => str,
    red: (str: string) => str,
    yellow: (str: string) => str,
  };
  return mockChalk;
});

// Mock conf before importing
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

// Mock the generated client
jest.mock('../generated', () => ({
  projectsControllerFindAll: jest.fn(),
  projectsControllerFindBySlug: jest.fn(),
  projectsControllerCreate: jest.fn(),
  projectsControllerRemove: jest.fn(),
  OpenAPI: { BASE: '', TOKEN: '' },
}));

jest.mock('../generated/core/OpenAPI', () => ({
  OpenAPI: { BASE: '', TOKEN: '' },
}));

// Mock config module to use mockData instead of real filesystem
jest.mock('../config', () => ({
  getConfig: jest.fn(() => ({
    apiKey: mockData.apiKey || '',
    apiUrl: mockData.apiUrl || '',
  })),
  setConfig: jest.fn(),
  validateApiKey: jest.fn((key: string) => key && key.length >= 10),
  maskApiKey: jest.fn((key: string) => {
    if (key.length <= 8) return '****';
    return key.substring(0, 4) + '*'.repeat(key.length - 8) + key.substring(key.length - 4);
  }),
}));

import { Command } from 'commander';
import { projectCommand } from './project';
import {
  projectsControllerFindAll,
  projectsControllerFindBySlug,
  projectsControllerCreate,
  projectsControllerRemove,
} from '../generated';

describe('projectCommand', () => {
  let program: Command;
  let exitSpy: jest.SpyInstance;
  let logSpy: jest.SpyInstance;

  beforeEach(() => {
    program = new Command();
    projectCommand(program);

    // Setup default config
    mockData.apiKey = 'sk-test-key123';
    mockData.apiUrl = 'http://localhost:3100/api';

    // Clear environment variables
    delete process.env.KODA_API_KEY;
    delete process.env.KODA_API_URL;

    exitSpy = jest.spyOn(process, 'exit').mockImplementation((() => {
      // Don't throw, just record the call
    }) as any);

    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

    jest.clearAllMocks();
    (projectsControllerFindAll as jest.Mock).mockReset();
    (projectsControllerFindBySlug as jest.Mock).mockReset();
    (projectsControllerCreate as jest.Mock).mockReset();
    (projectsControllerRemove as jest.Mock).mockReset();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('project list', () => {
    it('fetches and displays projects in table format', async () => {
      const mockProjects = [
        { id: '1', name: 'Project A', key: 'PA', slug: 'project-a' },
        { id: '2', name: 'Project B', key: 'PB', slug: 'project-b' },
      ];

      (projectsControllerFindAll as jest.Mock).mockResolvedValue({
        ret: 0,
        data: { items: mockProjects, total: 2 },
      });

      const projectCmd = program.commands.find((cmd) => cmd.name() === 'project');
      const listCmd = projectCmd?.commands.find((cmd) => cmd.name() === 'list');

      await listCmd?.parse(['node', 'test']);

      expect(projectsControllerFindAll).toHaveBeenCalled();
    });

    it('returns JSON array with --json flag', async () => {
      const mockProjects = [
        { id: '1', name: 'Project A', key: 'PA', slug: 'project-a' },
      ];

      (projectsControllerFindAll as jest.Mock).mockResolvedValue({
        ret: 0,
        data: { items: mockProjects, total: 1 },
      });

      const projectCmd = program.commands.find((cmd) => cmd.name() === 'project');
      const listCmd = projectCmd?.commands.find((cmd) => cmd.name() === 'list');

      try {
        await listCmd?.parse(['node', 'test', '--json']);
      } catch {
        // Expected
      }

      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining('Project A')
      );
    });

    it('exits with code 2 when API key is not configured', async () => {
      mockData.apiKey = '';
      mockData.apiUrl = '';

      const projectCmd = program.commands.find((cmd) => cmd.name() === 'project');
      const listCmd = projectCmd?.commands.find((cmd) => cmd.name() === 'list');

      try {
        await listCmd?.parse(['node', 'test']);
      } catch {
        // Expected
      }

      expect(exitSpy).toHaveBeenCalledWith(2);
    });

    it('uses KODA_API_KEY environment variable when config is empty', async () => {
      mockData.apiKey = '';
      mockData.apiUrl = '';
      process.env.KODA_API_KEY = 'sk-test-key-from-env-at-least-10-chars';
      process.env.KODA_API_URL = 'http://env.example.com/api';

      const mockProjects = [
        { id: '1', name: 'Project A', key: 'PA', slug: 'project-a' },
      ];

      (projectsControllerFindAll as jest.Mock).mockResolvedValue({
        ret: 0,
        data: { items: mockProjects, total: 1 },
      });

      const projectCmd = program.commands.find((cmd) => cmd.name() === 'project');
      const listCmd = projectCmd?.commands.find((cmd) => cmd.name() === 'list');

      try {
        await listCmd?.parse(['node', 'test']);
      } catch {
        // Expected
      }

      expect(projectsControllerFindAll).toHaveBeenCalled();
    });

    it('prefers KODA_API_KEY over config file', async () => {
      mockData.apiKey = 'sk-test-key-from-config-at-least-10-chars';
      mockData.apiUrl = 'http://config.example.com/api';
      process.env.KODA_API_KEY = 'sk-test-key-from-env-override-at-least-10-chars';
      process.env.KODA_API_URL = 'http://env-override.example.com/api';

      const mockProjects = [
        { id: '1', name: 'Project A', key: 'PA', slug: 'project-a' },
      ];

      (projectsControllerFindAll as jest.Mock).mockResolvedValue({
        ret: 0,
        data: { items: mockProjects, total: 1 },
      });

      const projectCmd = program.commands.find((cmd) => cmd.name() === 'project');
      const listCmd = projectCmd?.commands.find((cmd) => cmd.name() === 'list');

      try {
        await listCmd?.parse(['node', 'test']);
      } catch {
        // Expected
      }

      expect(projectsControllerFindAll).toHaveBeenCalled();
    });

    it('handles API errors gracefully', async () => {
      const mockError = new Error('API Error');
      (mockError as any).response = { status: 500 };

      (projectsControllerFindAll as jest.Mock).mockRejectedValue(mockError);

      const projectCmd = program.commands.find((cmd) => cmd.name() === 'project');
      const listCmd = projectCmd?.commands.find((cmd) => cmd.name() === 'list');

      try {
        await listCmd?.parse(['node', 'test']);
      } catch {
        // Expected
      }

      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it('exits with code 2 on unauthorized error', async () => {
      const mockError = new Error('Unauthorized');
      (mockError as any).response = { status: 401 };

      (projectsControllerFindAll as jest.Mock).mockRejectedValue(mockError);

      const projectCmd = program.commands.find((cmd) => cmd.name() === 'project');
      const listCmd = projectCmd?.commands.find((cmd) => cmd.name() === 'list');

      try {
        await listCmd?.parse(['node', 'test']);
      } catch {
        // Expected
      }

      expect(exitSpy).toHaveBeenCalledWith(2);
    });
  });

  describe('project create', () => {
    it('creates project and displays it in table format', async () => {
      const mockProject = {
        id: '1',
        name: 'Test',
        key: 'TEST',
        slug: 'test',
        description: 'A test project',
      };

      (projectsControllerCreate as jest.Mock).mockResolvedValue({ ret: 0, data: mockProject });

      const projectCmd = program.commands.find((cmd) => cmd.name() === 'project');
      const createCmd = projectCmd?.commands.find((cmd) => cmd.name() === 'create');

      await createCmd?.parseAsync(['node', 'test', '--name', 'Test', '--slug', 'test', '--key', 'TEST']);

      expect(projectsControllerCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          requestBody: expect.objectContaining({ name: 'Test', slug: 'test', key: 'TEST' }),
        })
      );
    });

    it('exits 3 with invalid key format (lowercase)', async () => {
      const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

      const projectCmd = program.commands.find((cmd) => cmd.name() === 'project');
      const createCmd = projectCmd?.commands.find((cmd) => cmd.name() === 'create');

      await createCmd?.parseAsync([
        'node', 'test', '--name', 'Test', '--slug', 'test', '--key', 'my-key',
      ]);

      expect(exitSpy).toHaveBeenCalledWith(3);
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('Invalid key format')
      );

      errorSpy.mockRestore();
    });

    it('exits 3 with invalid slug format (uppercase)', async () => {
      const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

      const projectCmd = program.commands.find((cmd) => cmd.name() === 'project');
      const createCmd = projectCmd?.commands.find((cmd) => cmd.name() === 'create');

      await createCmd?.parseAsync([
        'node', 'test', '--name', 'Test', '--slug', 'My_App', '--key', 'TEST',
      ]);

      expect(exitSpy).toHaveBeenCalledWith(3);
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('Invalid slug format')
      );

      errorSpy.mockRestore();
    });

    it('outputs unwrapped project JSON with --json flag', async () => {
      const mockProject = {
        id: '1',
        name: 'Test',
        key: 'TEST',
        slug: 'test',
      };

      (projectsControllerCreate as jest.Mock).mockResolvedValue({ ret: 0, data: mockProject });

      const projectCmd = program.commands.find((cmd) => cmd.name() === 'project');
      const createCmd = projectCmd?.commands.find((cmd) => cmd.name() === 'create');

      await createCmd?.parseAsync([
        'node', 'test', '--name', 'Test', '--slug', 'test', '--key', 'TEST', '--json',
      ]);

      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining('"key": "TEST"')
      );
    });

    it('exits with code 2 when API key is not configured', async () => {
      mockData.apiKey = '';
      mockData.apiUrl = '';

      const projectCmd = program.commands.find((cmd) => cmd.name() === 'project');
      const createCmd = projectCmd?.commands.find((cmd) => cmd.name() === 'create');

      await createCmd?.parseAsync([
        'node', 'test', '--name', 'Test', '--slug', 'test', '--key', 'TEST',
      ]);

      expect(exitSpy).toHaveBeenCalledWith(2);
    });
  });

  describe('project delete', () => {
    it('deletes project when --force flag is provided', async () => {
      (projectsControllerRemove as jest.Mock).mockResolvedValue(undefined);

      const projectCmd = program.commands.find((cmd) => cmd.name() === 'project');
      const deleteCmd = projectCmd?.commands.find((cmd) => cmd.name() === 'delete');

      await deleteCmd?.parseAsync(['node', 'test', 'test', '--force']);

      expect(projectsControllerRemove).toHaveBeenCalledWith(
        expect.objectContaining({ slug: 'test' })
      );
    });

    it('exits 1 with message when --force is not provided', async () => {
      const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

      const projectCmd = program.commands.find((cmd) => cmd.name() === 'project');
      const deleteCmd = projectCmd?.commands.find((cmd) => cmd.name() === 'delete');

      await deleteCmd?.parseAsync(['node', 'test', 'test']);

      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('Use --force to confirm deletion')
      );

      errorSpy.mockRestore();
    });

    it('exits with code 2 when API key is not configured', async () => {
      mockData.apiKey = '';
      mockData.apiUrl = '';

      const projectCmd = program.commands.find((cmd) => cmd.name() === 'project');
      const deleteCmd = projectCmd?.commands.find((cmd) => cmd.name() === 'delete');

      await deleteCmd?.parseAsync(['node', 'test', 'test', '--force']);

      expect(exitSpy).toHaveBeenCalledWith(2);
    });
  });

  describe('project show', () => {
    it('fetches and displays project details', async () => {
      const mockProject = {
        id: '1',
        name: 'Project A',
        key: 'PA',
        slug: 'project-a',
        description: 'Test project',
      };

      (projectsControllerFindBySlug as jest.Mock).mockResolvedValue({ ret: 0, data: mockProject });

      const projectCmd = program.commands.find((cmd) => cmd.name() === 'project');
      const showCmd = projectCmd?.commands.find((cmd) => cmd.name() === 'show');

      try {
        await showCmd?.parse(['node', 'test', 'project-a']);
      } catch {
        // Expected
      }

      expect(projectsControllerFindBySlug).toHaveBeenCalled();
    });

    it('returns JSON object with --json flag', async () => {
      const mockProject = {
        id: '1',
        name: 'Project A',
        key: 'PA',
        slug: 'project-a',
      };

      (projectsControllerFindBySlug as jest.Mock).mockResolvedValue({ ret: 0, data: mockProject });

      const projectCmd = program.commands.find((cmd) => cmd.name() === 'project');
      const showCmd = projectCmd?.commands.find((cmd) => cmd.name() === 'show');

      try {
        await showCmd?.parse(['node', 'test', 'project-a', '--json']);
      } catch {
        // Expected
      }

      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining('Project A')
      );
    });

    it('handles 404 not found errors', async () => {
      const mockError = new Error('Not found');
      (mockError as any).response = { status: 404 };

      (projectsControllerFindBySlug as jest.Mock).mockRejectedValue(mockError);

      const projectCmd = program.commands.find((cmd) => cmd.name() === 'project');
      const showCmd = projectCmd?.commands.find((cmd) => cmd.name() === 'show');

      try {
        await showCmd?.parse(['node', 'test', 'nonexistent']);
      } catch {
        // Expected
      }

      expect(exitSpy).toHaveBeenCalledWith(4);
    });

    it('exits with code 2 when API key is not configured', async () => {
      mockData.apiKey = '';

      const projectCmd = program.commands.find((cmd) => cmd.name() === 'project');
      const showCmd = projectCmd?.commands.find((cmd) => cmd.name() === 'show');

      try {
        await showCmd?.parse(['node', 'test', 'project-a']);
      } catch {
        // Expected
      }

      expect(exitSpy).toHaveBeenCalledWith(2);
    });

    it('displays key and description fields in table', async () => {
      const mockProject = {
        id: '1',
        name: 'Project A',
        key: 'PA',
        slug: 'project-a',
        description: 'A nice project description',
      };

      (projectsControllerFindBySlug as jest.Mock).mockResolvedValue({ ret: 0, data: mockProject });

      const projectCmd = program.commands.find((cmd) => cmd.name() === 'project');
      const showCmd = projectCmd?.commands.find((cmd) => cmd.name() === 'show');

      try {
        await showCmd?.parse(['node', 'test', 'project-a']);
      } catch {
        // Expected
      }

      const allCalls = logSpy.mock.calls.flat().join(' ');
      expect(allCalls).toContain('Description');
      expect(allCalls).toContain('A nice project description');
    });
  });
});
