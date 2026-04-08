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
  labelsControllerCreateFromHttp: jest.fn(),
  labelsControllerFindByProjectFromHttp: jest.fn(),
  labelsControllerDeleteFromHttp: jest.fn(),
  labelsControllerUpdateFromHttp: jest.fn(),
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
  resolveContext: jest.fn(),
  setConfig: jest.fn(),
  validateApiKey: jest.fn((key: string) => key && key.length >= 10),
  maskApiKey: jest.fn((key: string) => {
    if (key.length <= 8) return '****';
    return key.substring(0, 4) + '*'.repeat(key.length - 8) + key.substring(key.length - 4);
  }),
}));

import { Command } from 'commander';
import { labelCommand } from './label';
import {
  labelsControllerCreateFromHttp,
  labelsControllerFindByProjectFromHttp,
  labelsControllerDeleteFromHttp,
  labelsControllerUpdateFromHttp,
} from '../generated';
import { resolveContext } from '../config';

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
    (resolveContext as jest.Mock).mockResolvedValue({
      projectSlug: 'koda',
      apiKey: 'sk-test-key123',
      apiUrl: 'http://localhost:3100/api',
    });
    (labelsControllerCreateFromHttp as jest.Mock).mockReset();
    (labelsControllerFindByProjectFromHttp as jest.Mock).mockReset();
    (labelsControllerDeleteFromHttp as jest.Mock).mockReset();
    (labelsControllerUpdateFromHttp as jest.Mock).mockReset();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('label create', () => {
    it('creates and displays label in table format', async () => {
      const mockLabel = { id: 'lbl-1', name: 'Bug', color: '#ff0000', projectId: 'p-1' };

      (labelsControllerCreateFromHttp as jest.Mock).mockResolvedValue({ ret: 0, data: mockLabel });

      const labelCmd = program.commands.find((cmd) => cmd.name() === 'label');
      const createCmd = labelCmd?.commands.find((cmd) => cmd.name() === 'create');

      await createCmd?.parseAsync([
        'node', 'test', '--project', 'koda', '--name', 'Bug', '--color', '#ff0000',
      ]);

      expect(labelsControllerCreateFromHttp).toHaveBeenCalledWith(
        expect.objectContaining({
          slug: 'koda',
          requestBody: expect.objectContaining({ name: 'Bug', color: '#ff0000' }),
        })
      );
      expect(exitSpy).toHaveBeenCalledWith(0);
    });

    it('outputs unwrapped label JSON with --json flag', async () => {
      const mockLabel = { id: 'lbl-1', name: 'Bug', color: '#ff0000', projectId: 'p-1' };

      (labelsControllerCreateFromHttp as jest.Mock).mockResolvedValue({ ret: 0, data: mockLabel });

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
      (resolveContext as jest.Mock).mockResolvedValue({
        projectSlug: 'koda',
        apiKey: '',
        apiUrl: '',
      });

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
      (labelsControllerCreateFromHttp as jest.Mock).mockRejectedValue(mockError);

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

      (labelsControllerFindByProjectFromHttp as jest.Mock).mockResolvedValue({
        ret: 0,
        data: { items: mockLabels, total: 2 },
      });

      const labelCmd = program.commands.find((cmd) => cmd.name() === 'label');
      const listCmd = labelCmd?.commands.find((cmd) => cmd.name() === 'list');

      await listCmd?.parseAsync(['node', 'test', '--project', 'koda']);

      expect(labelsControllerFindByProjectFromHttp).toHaveBeenCalledWith(
        expect.objectContaining({ slug: 'koda' })
      );
      expect(exitSpy).toHaveBeenCalledWith(0);
    });

    it('outputs JSON array with --json flag', async () => {
      const mockLabels = [
        { id: 'lbl-1', name: 'Bug', color: '#ff0000', projectId: 'p-1' },
      ];

      (labelsControllerFindByProjectFromHttp as jest.Mock).mockResolvedValue({
        ret: 0,
        data: { items: mockLabels, total: 1 },
      });

      const labelCmd = program.commands.find((cmd) => cmd.name() === 'label');
      const listCmd = labelCmd?.commands.find((cmd) => cmd.name() === 'list');

      await listCmd?.parseAsync(['node', 'test', '--project', 'koda', '--json']);

      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining('"name": "Bug"')
      );
    });

    it('exits 2 when API key is not configured', async () => {
      (resolveContext as jest.Mock).mockResolvedValue({
        projectSlug: 'koda',
        apiKey: '',
        apiUrl: '',
      });

      const labelCmd = program.commands.find((cmd) => cmd.name() === 'label');
      const listCmd = labelCmd?.commands.find((cmd) => cmd.name() === 'list');

      await listCmd?.parseAsync(['node', 'test', '--project', 'koda']);

      expect(exitSpy).toHaveBeenCalledWith(2);
    });
  });

  describe('label delete', () => {
    it('deletes a label by id', async () => {
      (labelsControllerDeleteFromHttp as jest.Mock).mockResolvedValue(undefined);

      const labelCmd = program.commands.find((cmd) => cmd.name() === 'label');
      const deleteCmd = labelCmd?.commands.find((cmd) => cmd.name() === 'delete');

      await deleteCmd?.parseAsync([
        'node', 'test', '--project', 'koda', '--id', 'lbl-1',
      ]);

      expect(labelsControllerDeleteFromHttp).toHaveBeenCalledWith(
        expect.objectContaining({ slug: 'koda', id: 'lbl-1' })
      );
      expect(exitSpy).toHaveBeenCalledWith(0);
    });

    it('exits 2 when API key is not configured', async () => {
      (resolveContext as jest.Mock).mockResolvedValue({
        projectSlug: 'koda',
        apiKey: '',
        apiUrl: '',
      });

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
      (labelsControllerDeleteFromHttp as jest.Mock).mockRejectedValue(mockError);

      const labelCmd = program.commands.find((cmd) => cmd.name() === 'label');
      const deleteCmd = labelCmd?.commands.find((cmd) => cmd.name() === 'delete');

      await deleteCmd?.parseAsync([
        'node', 'test', '--project', 'koda', '--id', 'nonexistent',
      ]);

      expect(exitSpy).toHaveBeenCalledWith(1);
    });
  });

  describe('label update', () => {
    it('updates a label by id', async () => {
      const mockLabel = { id: 'lbl-1', name: 'Bug Updated', color: '#123456' };
      (labelsControllerUpdateFromHttp as jest.Mock).mockResolvedValue({ ret: 0, data: mockLabel });

      const labelCmd = program.commands.find((cmd) => cmd.name() === 'label');
      const updateCmd = labelCmd?.commands.find((cmd) => cmd.name() === 'update');

      await updateCmd?.parseAsync([
        'node', 'test', '--project', 'koda', '--id', 'lbl-1', '--name', 'Bug Updated',
      ]);

      expect(labelsControllerUpdateFromHttp).toHaveBeenCalledWith(
        expect.objectContaining({
          slug: 'koda',
          id: 'lbl-1',
          requestBody: expect.objectContaining({ name: 'Bug Updated' }),
        })
      );
      expect(exitSpy).toHaveBeenCalledWith(0);
    });

    it('exits 3 when no update fields are provided', async () => {
      const labelCmd = program.commands.find((cmd) => cmd.name() === 'label');
      const updateCmd = labelCmd?.commands.find((cmd) => cmd.name() === 'update');

      await updateCmd?.parseAsync([
        'node', 'test', '--project', 'koda', '--id', 'lbl-1',
      ]).catch(() => undefined);

      expect(exitSpy).toHaveBeenCalledWith(3);
    });
  });
});
