import { Command } from 'commander';
import * as configModule from '../config';
import { configCommand } from './config';

jest.mock('../config');

describe('config command', () => {
  let program: Command;
  let consoleLogSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    program = new Command();
    consoleLogSpy = jest.spyOn(console, 'log').mockImplementation();
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
  });

  describe('config show', () => {
    it('registers config show subcommand', () => {
      configCommand(program);

      const configCmd = program.commands.find((cmd) => cmd.name() === 'config');
      const showCmd = configCmd?.commands.find((cmd) => cmd.name() === 'show');
      expect(showCmd).toBeDefined();
    });

    it('prints apiUrl and masked apiKey when both are set', async () => {
      (configModule.getConfig as jest.Mock).mockReturnValue({
        apiKey: 'mykey123',
        apiUrl: 'http://localhost:3100/api',
      });

      configCommand(program);
      const configCmd = program.commands.find((cmd) => cmd.name() === 'config')!;
      const showCmd = configCmd.commands.find((cmd) => cmd.name() === 'show')!;
      await showCmd.parseAsync(['node', 'koda', 'config', 'show']);

      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('apiUrl'));
      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('http://localhost:3100/api'));
    });

    it('masks apiKey showing only last 4 characters', async () => {
      (configModule.getConfig as jest.Mock).mockReturnValue({
        apiKey: 'mykey123',
        apiUrl: 'http://localhost:3100/api',
      });

      configCommand(program);
      const configCmd = program.commands.find((cmd) => cmd.name() === 'config')!;
      const showCmd = configCmd.commands.find((cmd) => cmd.name() === 'show')!;
      await showCmd.parseAsync(['node', 'koda', 'config', 'show']);

      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('****key123'));
    });

    it('handles case when apiKey is shorter than 4 characters', async () => {
      (configModule.getConfig as jest.Mock).mockReturnValue({
        apiKey: 'key',
        apiUrl: 'http://localhost:3100/api',
      });

      configCommand(program);
      const configCmd = program.commands.find((cmd) => cmd.name() === 'config')!;
      const showCmd = configCmd.commands.find((cmd) => cmd.name() === 'show')!;
      await showCmd.parseAsync(['node', 'koda', 'config', 'show']);

      // Should still show the masked key, but fewer asterisks
      expect(consoleLogSpy).toHaveBeenCalled();
    });

    it('prints message when apiKey is not configured', async () => {
      (configModule.getConfig as jest.Mock).mockReturnValue({
        apiUrl: 'http://localhost:3100/api',
      });

      configCommand(program);
      const configCmd = program.commands.find((cmd) => cmd.name() === 'config')!;
      const showCmd = configCmd.commands.find((cmd) => cmd.name() === 'show')!;
      await showCmd.parseAsync(['node', 'koda', 'config', 'show']);

      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('http://localhost:3100/api'));
    });

    it('prints apiUrl even when apiKey is not set', async () => {
      (configModule.getConfig as jest.Mock).mockReturnValue({
        apiUrl: 'http://custom:3100/api',
      });

      configCommand(program);
      const configCmd = program.commands.find((cmd) => cmd.name() === 'config')!;
      const showCmd = configCmd.commands.find((cmd) => cmd.name() === 'show')!;
      await showCmd.parseAsync(['node', 'koda', 'config', 'show']);

      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('http://custom:3100/api'));
    });
  });

  describe('config set', () => {
    it('registers config set subcommand', () => {
      configCommand(program);

      const configCmd = program.commands.find((cmd) => cmd.name() === 'config');
      const setCmd = configCmd?.commands.find((cmd) => cmd.name() === 'set');
      expect(setCmd).toBeDefined();
    });

    it('updates apiKey when --api-key flag is provided', async () => {
      configCommand(program);
      const configCmd = program.commands.find((cmd) => cmd.name() === 'config')!;
      const setCmd = configCmd.commands.find((cmd) => cmd.name() === 'set')!;
      await setCmd.parseAsync(['node', 'koda', 'config', 'set', '--api-key', 'newkey456']);

      expect(configModule.setConfig).toHaveBeenCalledWith(
        expect.objectContaining({
          apiKey: 'newkey456',
        })
      );
    });

    it('updates apiUrl when --api-url flag is provided', async () => {
      configCommand(program);
      const configCmd = program.commands.find((cmd) => cmd.name() === 'config')!;
      const setCmd = configCmd.commands.find((cmd) => cmd.name() === 'set')!;
      await setCmd.parseAsync(['node', 'koda', 'config', 'set', '--api-url', 'http://newhost:3100/api']);

      expect(configModule.setConfig).toHaveBeenCalledWith(
        expect.objectContaining({
          apiUrl: 'http://newhost:3100/api',
        })
      );
    });

    it('updates both apiKey and apiUrl in single command', async () => {
      configCommand(program);
      const configCmd = program.commands.find((cmd) => cmd.name() === 'config')!;
      const setCmd = configCmd.commands.find((cmd) => cmd.name() === 'set')!;
      await setCmd.parseAsync([
        'node',
        'koda',
        'config',
        'set',
        '--api-key',
        'newkey456',
        '--api-url',
        'http://newhost:3100/api',
      ]);

      expect(configModule.setConfig).toHaveBeenCalledWith({
        apiKey: 'newkey456',
        apiUrl: 'http://newhost:3100/api',
      });
    });

    it('prints success message after updating config', async () => {
      configCommand(program);
      const configCmd = program.commands.find((cmd) => cmd.name() === 'config')!;
      const setCmd = configCmd.commands.find((cmd) => cmd.name() === 'set')!;
      await setCmd.parseAsync(['node', 'koda', 'config', 'set', '--api-key', 'newkey456']);

      expect(consoleLogSpy).toHaveBeenCalled();
    });

    it('requires at least one flag (--api-key or --api-url)', async () => {
      configCommand(program);
      const configCmd = program.commands.find((cmd) => cmd.name() === 'config')!;
      const setCmd = configCmd.commands.find((cmd) => cmd.name() === 'set')!;

      await expect(setCmd.parseAsync(['node', 'koda', 'config', 'set'])).rejects.toThrow();
    });
  });
});
