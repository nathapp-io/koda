import { Command } from 'commander';
import * as fs from 'fs';
import * as path from 'path';
import { versionCommand } from './version';

jest.mock('fs');

describe('version command', () => {
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

  it('registers version command with Commander', () => {
    versionCommand(program);

    const versionCmd = program.commands.find((cmd) => cmd.name() === 'version');
    expect(versionCmd).toBeDefined();
  });

  it('prints version from package.json', async () => {
    const packageJson = {
      name: '@nathapp/koda',
      version: '0.1.0',
    };

    (fs.readFileSync as jest.Mock).mockReturnValue(JSON.stringify(packageJson));

    versionCommand(program);
    const versionCmd = program.commands.find((cmd) => cmd.name() === 'version')!;
    await versionCmd.parseAsync(['node', 'koda', 'version']);

    expect(consoleLogSpy).toHaveBeenCalledWith('0.1.0');
  });

  it('reads version from package.json in project root', async () => {
    const packageJson = {
      name: '@nathapp/koda',
      version: '0.1.0',
    };

    (fs.readFileSync as jest.Mock).mockReturnValue(JSON.stringify(packageJson));

    versionCommand(program);
    const versionCmd = program.commands.find((cmd) => cmd.name() === 'version')!;
    await versionCmd.parseAsync(['node', 'koda', 'version']);

    expect(fs.readFileSync).toHaveBeenCalledWith(expect.stringContaining('package.json'), 'utf-8');
  });

  it('handles missing package.json gracefully', async () => {
    (fs.readFileSync as jest.Mock).mockImplementation(() => {
      throw new Error('ENOENT: no such file or directory');
    });

    versionCommand(program);
    const versionCmd = program.commands.find((cmd) => cmd.name() === 'version')!;

    await expect(versionCmd.parseAsync(['node', 'koda', 'version'])).rejects.toThrow();
  });

  it('parses version correctly from package.json', async () => {
    const packageJson = {
      name: '@nathapp/koda',
      version: '1.2.3',
      description: 'CLI for Koda',
    };

    (fs.readFileSync as jest.Mock).mockReturnValue(JSON.stringify(packageJson));

    versionCommand(program);
    const versionCmd = program.commands.find((cmd) => cmd.name() === 'version')!;
    await versionCmd.parseAsync(['node', 'koda', 'version']);

    expect(consoleLogSpy).toHaveBeenCalledWith('1.2.3');
  });

  it('only prints version number, not package name', async () => {
    const packageJson = {
      name: '@nathapp/koda',
      version: '0.1.0',
    };

    (fs.readFileSync as jest.Mock).mockReturnValue(JSON.stringify(packageJson));

    versionCommand(program);
    const versionCmd = program.commands.find((cmd) => cmd.name() === 'version')!;
    await versionCmd.parseAsync(['node', 'koda', 'version']);

    // Should only print version, not name
    expect(consoleLogSpy).toHaveBeenCalledWith('0.1.0');
    expect(consoleLogSpy).not.toHaveBeenCalledWith('@nathapp/koda');
  });
});
