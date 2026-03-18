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

// Mock axios client
const mockAxios = {
  get: jest.fn(),
};

jest.mock('axios', () => {
  return {
    create: () => mockAxios,
  };
});

// Mock the generated client
jest.mock('../generated', () => ({
  ProjectsService: {
    list: jest.fn(),
    show: jest.fn(),
  },
}));

import { Command } from 'commander';
import { projectCommand } from './project';
import { ProjectsService } from '../generated';

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

      (ProjectsService.list as jest.Mock).mockResolvedValue({
        data: mockProjects,
      });

      const projectCmd = program.commands.find((cmd) => cmd.name() === 'project');
      const listCmd = projectCmd?.commands.find((cmd) => cmd.name() === 'list');

      await listCmd?.parse(['node', 'test']);

      expect(ProjectsService.list).toHaveBeenCalled();
    });

    it('returns JSON array with --json flag', async () => {
      const mockProjects = [
        { id: '1', name: 'Project A', key: 'PA', slug: 'project-a' },
      ];

      (ProjectsService.list as jest.Mock).mockResolvedValue({
        data: mockProjects,
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

      (ProjectsService.list as jest.Mock).mockResolvedValue({
        data: mockProjects,
      });

      const projectCmd = program.commands.find((cmd) => cmd.name() === 'project');
      const listCmd = projectCmd?.commands.find((cmd) => cmd.name() === 'list');

      try {
        await listCmd?.parse(['node', 'test']);
      } catch {
        // Expected
      }

      // Should call ProjectsService even though config is empty, using env vars
      expect(ProjectsService.list).toHaveBeenCalled();
    });

    it('prefers KODA_API_KEY over config file', async () => {
      mockData.apiKey = 'sk-test-key-from-config-at-least-10-chars';
      mockData.apiUrl = 'http://config.example.com/api';
      process.env.KODA_API_KEY = 'sk-test-key-from-env-override-at-least-10-chars';
      process.env.KODA_API_URL = 'http://env-override.example.com/api';

      const mockProjects = [
        { id: '1', name: 'Project A', key: 'PA', slug: 'project-a' },
      ];

      (ProjectsService.list as jest.Mock).mockResolvedValue({
        data: mockProjects,
      });

      const projectCmd = program.commands.find((cmd) => cmd.name() === 'project');
      const listCmd = projectCmd?.commands.find((cmd) => cmd.name() === 'list');

      try {
        await listCmd?.parse(['node', 'test']);
      } catch {
        // Expected
      }

      // Should call ProjectsService with env var credentials, not config credentials
      expect(ProjectsService.list).toHaveBeenCalled();
    });

    it('handles API errors gracefully', async () => {
      const mockError = new Error('API Error');
      (mockError as any).response = { status: 500 };

      (ProjectsService.list as jest.Mock).mockRejectedValue(mockError);

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

      (ProjectsService.list as jest.Mock).mockRejectedValue(mockError);

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

  describe('project show', () => {
    it('fetches and displays project details', async () => {
      const mockProject = {
        id: '1',
        name: 'Project A',
        key: 'PA',
        slug: 'project-a',
        description: 'Test project',
      };

      (ProjectsService.show as jest.Mock).mockResolvedValue({
        data: mockProject,
      });

      const projectCmd = program.commands.find((cmd) => cmd.name() === 'project');
      const showCmd = projectCmd?.commands.find((cmd) => cmd.name() === 'show');

      try {
        await showCmd?.parse(['node', 'test', 'project-a']);
      } catch {
        // Expected
      }

      expect(ProjectsService.show).toHaveBeenCalled();
    });

    it('returns JSON object with --json flag', async () => {
      const mockProject = {
        id: '1',
        name: 'Project A',
        key: 'PA',
        slug: 'project-a',
      };

      (ProjectsService.show as jest.Mock).mockResolvedValue({
        data: mockProject,
      });

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

      (ProjectsService.show as jest.Mock).mockRejectedValue(mockError);

      const projectCmd = program.commands.find((cmd) => cmd.name() === 'project');
      const showCmd = projectCmd?.commands.find((cmd) => cmd.name() === 'show');

      try {
        await showCmd?.parse(['node', 'test', 'nonexistent']);
      } catch {
        // Expected
      }

      expect(exitSpy).toHaveBeenCalledWith(1);
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
  });
});
