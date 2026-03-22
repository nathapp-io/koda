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
  post: jest.fn(),
  delete: jest.fn(),
};

jest.mock('axios', () => {
  return {
    create: () => mockAxios,
  };
});

// Mock the generated client
jest.mock('../generated', () => ({
  LabelsService: {
    create: jest.fn(),
    list: jest.fn(),
    delete: jest.fn(),
    addToTicket: jest.fn(),
    removeFromTicket: jest.fn(),
  },
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
import { labelCommand } from './label';
import { LabelsService } from '../generated';

describe('labelCommand', () => {
  let program: Command;
  let exitSpy: jest.SpyInstance;
  let logSpy: jest.SpyInstance;

  beforeEach(() => {
    program = new Command();
    labelCommand(program);

    mockData.apiKey = 'sk-test-key123';
    mockData.apiUrl = 'http://localhost:3100/api';

    delete process.env.KODA_API_KEY;
    delete process.env.KODA_API_URL;

    exitSpy = jest.spyOn(process, 'exit').mockImplementation((() => {}) as any);
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

    jest.clearAllMocks();
    (LabelsService.create as jest.Mock).mockReset();
    (LabelsService.list as jest.Mock).mockReset();
    (LabelsService.delete as jest.Mock).mockReset();
    (LabelsService.addToTicket as jest.Mock).mockReset();
    (LabelsService.removeFromTicket as jest.Mock).mockReset();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('label create', () => {
    it('creates and displays label in table format', async () => {
      const mockLabel = { id: 'lbl-1', name: 'Bug', color: '#ff0000', projectId: 'p-1' };

      (LabelsService.create as jest.Mock).mockResolvedValue({
        data: { ret: 0, data: mockLabel },
      });

      const labelCmd = program.commands.find((cmd) => cmd.name() === 'label');
      const createCmd = labelCmd?.commands.find((cmd) => cmd.name() === 'create');

      await createCmd?.parseAsync([
        'node', 'test', '--project', 'koda', '--name', 'Bug', '--color', '#ff0000',
      ]);

      expect(LabelsService.create).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ projectSlug: 'koda', name: 'Bug', color: '#ff0000' })
      );
      expect(exitSpy).toHaveBeenCalledWith(0);
    });

    it('outputs unwrapped label JSON with --json flag', async () => {
      const mockLabel = { id: 'lbl-1', name: 'Bug', color: '#ff0000', projectId: 'p-1' };

      (LabelsService.create as jest.Mock).mockResolvedValue({
        data: { ret: 0, data: mockLabel },
      });

      const labelCmd = program.commands.find((cmd) => cmd.name() === 'label');
      const createCmd = labelCmd?.commands.find((cmd) => cmd.name() === 'create');

      await createCmd?.parseAsync([
        'node', 'test', '--project', 'koda', '--name', 'Bug', '--json',
      ]);

      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining('"name": "Bug"')
      );
      expect(exitSpy).toHaveBeenCalledWith(0);
    });

    it('exits 2 when API key is not configured', async () => {
      mockData.apiKey = '';
      mockData.apiUrl = '';

      const labelCmd = program.commands.find((cmd) => cmd.name() === 'label');
      const createCmd = labelCmd?.commands.find((cmd) => cmd.name() === 'create');

      await createCmd?.parseAsync([
        'node', 'test', '--project', 'koda', '--name', 'Bug',
      ]);

      expect(exitSpy).toHaveBeenCalledWith(2);
    });

    it('handles API errors gracefully', async () => {
      const mockError = new Error('API Error');
      (mockError as any).response = { status: 500 };
      (LabelsService.create as jest.Mock).mockRejectedValue(mockError);

      const labelCmd = program.commands.find((cmd) => cmd.name() === 'label');
      const createCmd = labelCmd?.commands.find((cmd) => cmd.name() === 'create');

      await createCmd?.parseAsync([
        'node', 'test', '--project', 'koda', '--name', 'Bug',
      ]);

      expect(exitSpy).toHaveBeenCalledWith(1);
    });
  });

  describe('label list', () => {
    it('fetches and displays labels in table format', async () => {
      const mockLabels = [
        { id: 'lbl-1', name: 'Bug', color: '#ff0000', projectId: 'p-1' },
        { id: 'lbl-2', name: 'Feature', color: '#00ff00', projectId: 'p-1' },
      ];

      (LabelsService.list as jest.Mock).mockResolvedValue({
        data: { ret: 0, data: { items: mockLabels, total: 2 } },
      });

      const labelCmd = program.commands.find((cmd) => cmd.name() === 'label');
      const listCmd = labelCmd?.commands.find((cmd) => cmd.name() === 'list');

      await listCmd?.parseAsync(['node', 'test', '--project', 'koda']);

      expect(LabelsService.list).toHaveBeenCalledWith(
        expect.anything(),
        'koda'
      );
      expect(exitSpy).toHaveBeenCalledWith(0);
    });

    it('outputs JSON array with --json flag', async () => {
      const mockLabels = [
        { id: 'lbl-1', name: 'Bug', color: '#ff0000', projectId: 'p-1' },
      ];

      (LabelsService.list as jest.Mock).mockResolvedValue({
        data: { ret: 0, data: { items: mockLabels, total: 1 } },
      });

      const labelCmd = program.commands.find((cmd) => cmd.name() === 'label');
      const listCmd = labelCmd?.commands.find((cmd) => cmd.name() === 'list');

      await listCmd?.parseAsync(['node', 'test', '--project', 'koda', '--json']);

      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining('"name": "Bug"')
      );
    });

    it('exits 2 when API key is not configured', async () => {
      mockData.apiKey = '';
      mockData.apiUrl = '';

      const labelCmd = program.commands.find((cmd) => cmd.name() === 'label');
      const listCmd = labelCmd?.commands.find((cmd) => cmd.name() === 'list');

      await listCmd?.parseAsync(['node', 'test', '--project', 'koda']);

      expect(exitSpy).toHaveBeenCalledWith(2);
    });
  });

  describe('label delete', () => {
    it('deletes a label by id', async () => {
      (LabelsService.delete as jest.Mock).mockResolvedValue({
        data: { ret: 0, data: null },
      });

      const labelCmd = program.commands.find((cmd) => cmd.name() === 'label');
      const deleteCmd = labelCmd?.commands.find((cmd) => cmd.name() === 'delete');

      await deleteCmd?.parseAsync([
        'node', 'test', '--project', 'koda', '--id', 'lbl-1',
      ]);

      expect(LabelsService.delete).toHaveBeenCalledWith(
        expect.anything(),
        'koda',
        'lbl-1'
      );
      expect(exitSpy).toHaveBeenCalledWith(0);
    });

    it('exits 2 when API key is not configured', async () => {
      mockData.apiKey = '';
      mockData.apiUrl = '';

      const labelCmd = program.commands.find((cmd) => cmd.name() === 'label');
      const deleteCmd = labelCmd?.commands.find((cmd) => cmd.name() === 'delete');

      await deleteCmd?.parseAsync([
        'node', 'test', '--project', 'koda', '--id', 'lbl-1',
      ]);

      expect(exitSpy).toHaveBeenCalledWith(2);
    });

    it('handles 404 not found errors', async () => {
      const mockError = new Error('Not found');
      (mockError as any).response = { status: 404 };
      (LabelsService.delete as jest.Mock).mockRejectedValue(mockError);

      const labelCmd = program.commands.find((cmd) => cmd.name() === 'label');
      const deleteCmd = labelCmd?.commands.find((cmd) => cmd.name() === 'delete');

      await deleteCmd?.parseAsync([
        'node', 'test', '--project', 'koda', '--id', 'nonexistent',
      ]);

      expect(exitSpy).toHaveBeenCalledWith(4);
    });
  });
});
