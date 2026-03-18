import { Command } from 'commander';
import { projectCommand } from './project';
import * as configModule from '../config';
import * as clientModule from '../client';
import { ProjectsService } from '../generated';

jest.mock('../config');
jest.mock('../client');
jest.mock('../generated', () => ({
  ProjectsService: {
    list: jest.fn(),
    show: jest.fn(),
  },
}));

describe('project command', () => {
  let program: Command;
  let consoleLogSpy: jest.SpyInstance;
  let processExitSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    program = new Command();
    consoleLogSpy = jest.spyOn(console, 'log').mockImplementation();
    processExitSpy = jest.spyOn(process, 'exit').mockImplementation(() => undefined as never);
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    processExitSpy.mockRestore();
  });

  describe('project list', () => {
    it('registers project list subcommand', () => {
      projectCommand(program);

      const projectCmd = program.commands.find((cmd) => cmd.name() === 'project');
      const listCmd = projectCmd?.commands.find((cmd) => cmd.name() === 'list');
      expect(listCmd).toBeDefined();
    });

    it('displays projects in table with Name, Key, Slug columns', async () => {
      (configModule.getConfig as jest.Mock).mockReturnValue({
        apiKey: 'test-key',
        apiUrl: 'http://localhost:3100/api',
      });
      (clientModule.configureClient as jest.Mock).mockReturnValue({});
      (ProjectsService.list as jest.Mock).mockResolvedValue({
        data: [
          { name: 'Koda', key: 'KODA', slug: 'koda', id: '1' },
          { name: 'Infra', key: 'INFRA', slug: 'infra', id: '2' },
        ],
      });

      projectCommand(program);
      const projectCmd = program.commands.find((cmd) => cmd.name() === 'project')!;
      const listCmd = projectCmd.commands.find((cmd) => cmd.name() === 'list')!;
      await listCmd.parseAsync(['node', 'koda', 'project', 'list']);

      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('Name'));
      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('Key'));
      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('Slug'));
      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('Koda'));
      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('KODA'));
      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('koda'));
    });

    it('outputs valid JSON array when --json flag is provided', async () => {
      (configModule.getConfig as jest.Mock).mockReturnValue({
        apiKey: 'test-key',
        apiUrl: 'http://localhost:3100/api',
      });
      (clientModule.configureClient as jest.Mock).mockReturnValue({});
      const mockProjects = [
        { name: 'Koda', key: 'KODA', slug: 'koda', id: '1' },
        { name: 'Infra', key: 'INFRA', slug: 'infra', id: '2' },
      ];
      (ProjectsService.list as jest.Mock).mockResolvedValue({
        data: mockProjects,
      });

      projectCommand(program);
      const projectCmd = program.commands.find((cmd) => cmd.name() === 'project')!;
      const listCmd = projectCmd.commands.find((cmd) => cmd.name() === 'list')!;
      await listCmd.parseAsync(['node', 'koda', 'project', 'list', '--json']);

      expect(consoleLogSpy).toHaveBeenCalled();
      const output = (consoleLogSpy.mock.calls[0][0] as string);
      const parsed = JSON.parse(output);
      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed).toHaveLength(2);
      expect(parsed[0]).toHaveProperty('name');
      expect(parsed[0]).toHaveProperty('key');
      expect(parsed[0]).toHaveProperty('slug');
    });

    it('calls ProjectsService.list with configured client', async () => {
      (configModule.getConfig as jest.Mock).mockReturnValue({
        apiKey: 'test-key',
        apiUrl: 'http://localhost:3100/api',
      });
      (clientModule.configureClient as jest.Mock).mockReturnValue({});
      (ProjectsService.list as jest.Mock).mockResolvedValue({
        data: [],
      });

      projectCommand(program);
      const projectCmd = program.commands.find((cmd) => cmd.name() === 'project')!;
      const listCmd = projectCmd.commands.find((cmd) => cmd.name() === 'list')!;
      await listCmd.parseAsync(['node', 'koda', 'project', 'list']);

      expect(clientModule.configureClient).toHaveBeenCalledWith(
        'http://localhost:3100/api',
        'test-key'
      );
      expect(ProjectsService.list).toHaveBeenCalled();
    });

    it('exits with code 2 if no API key configured', async () => {
      (configModule.getConfig as jest.Mock).mockReturnValue({
        apiUrl: 'http://localhost:3100/api',
      });

      projectCommand(program);
      const projectCmd = program.commands.find((cmd) => cmd.name() === 'project')!;
      const listCmd = projectCmd.commands.find((cmd) => cmd.name() === 'list')!;
      await listCmd.parseAsync(['node', 'koda', 'project', 'list']);

      expect(processExitSpy).toHaveBeenCalledWith(2);
    });
  });

  describe('project show', () => {
    it('registers project show subcommand', () => {
      projectCommand(program);

      const projectCmd = program.commands.find((cmd) => cmd.name() === 'project');
      const showCmd = projectCmd?.commands.find((cmd) => cmd.name() === 'show');
      expect(showCmd).toBeDefined();
    });

    it('displays project details in human-readable format', async () => {
      (configModule.getConfig as jest.Mock).mockReturnValue({
        apiKey: 'test-key',
        apiUrl: 'http://localhost:3100/api',
      });
      (clientModule.configureClient as jest.Mock).mockReturnValue({});
      (ProjectsService.show as jest.Mock).mockResolvedValue({
        data: {
          name: 'Koda',
          key: 'KODA',
          slug: 'koda',
          id: '1',
          description: 'Dev ticket tracker',
        },
      });

      projectCommand(program);
      const projectCmd = program.commands.find((cmd) => cmd.name() === 'project')!;
      const showCmd = projectCmd.commands.find((cmd) => cmd.name() === 'show')!;
      await showCmd.parseAsync(['node', 'koda', 'project', 'show', 'koda']);

      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('Koda'));
      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('KODA'));
      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('koda'));
    });

    it('outputs valid JSON object when --json flag is provided', async () => {
      (configModule.getConfig as jest.Mock).mockReturnValue({
        apiKey: 'test-key',
        apiUrl: 'http://localhost:3100/api',
      });
      (clientModule.configureClient as jest.Mock).mockReturnValue({});
      const mockProject = {
        name: 'Koda',
        key: 'KODA',
        slug: 'koda',
        id: '1',
        description: 'Dev ticket tracker',
      };
      (ProjectsService.show as jest.Mock).mockResolvedValue({
        data: mockProject,
      });

      projectCommand(program);
      const projectCmd = program.commands.find((cmd) => cmd.name() === 'project')!;
      const showCmd = projectCmd.commands.find((cmd) => cmd.name() === 'show')!;
      await showCmd.parseAsync(['node', 'koda', 'project', 'show', 'koda', '--json']);

      expect(consoleLogSpy).toHaveBeenCalled();
      const output = (consoleLogSpy.mock.calls[0][0] as string);
      const parsed = JSON.parse(output);
      expect(typeof parsed).toBe('object');
      expect(parsed).not.toBeNull();
      expect(Array.isArray(parsed)).toBe(false);
      expect(parsed).toHaveProperty('name');
      expect(parsed.name).toBe('Koda');
    });

    it('calls ProjectsService.show with project slug', async () => {
      (configModule.getConfig as jest.Mock).mockReturnValue({
        apiKey: 'test-key',
        apiUrl: 'http://localhost:3100/api',
      });
      (clientModule.configureClient as jest.Mock).mockReturnValue({});
      (ProjectsService.show as jest.Mock).mockResolvedValue({
        data: { name: 'Koda', key: 'KODA', slug: 'koda', id: '1' },
      });

      projectCommand(program);
      const projectCmd = program.commands.find((cmd) => cmd.name() === 'project')!;
      const showCmd = projectCmd.commands.find((cmd) => cmd.name() === 'show')!;
      await showCmd.parseAsync(['node', 'koda', 'project', 'show', 'koda']);

      expect(ProjectsService.show).toHaveBeenCalledWith(
        expect.any(Object),
        { path: { slug: 'koda' } }
      );
    });

    it('exits with code 2 if no API key configured', async () => {
      (configModule.getConfig as jest.Mock).mockReturnValue({
        apiUrl: 'http://localhost:3100/api',
      });

      projectCommand(program);
      const projectCmd = program.commands.find((cmd) => cmd.name() === 'project')!;
      const showCmd = projectCmd.commands.find((cmd) => cmd.name() === 'show')!;
      await showCmd.parseAsync(['node', 'koda', 'project', 'show', 'koda']);

      expect(processExitSpy).toHaveBeenCalledWith(2);
    });

    it('requires slug argument', () => {
      projectCommand(program);
      const projectCmd = program.commands.find((cmd) => cmd.name() === 'project')!;
      const showCmd = projectCmd.commands.find((cmd) => cmd.name() === 'show')!;

      expect(() => {
        showCmd.parse(['node', 'koda', 'project', 'show']);
      }).toThrow();
    });
  });
});
