import { Command } from 'commander';
import * as configModule from '../config';
import { loginCommand } from './login';

jest.mock('../config');

describe('login command', () => {
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

  it('registers login command with Commander', () => {
    loginCommand(program);

    const loginCmd = program.commands.find((cmd) => cmd.name() === 'login');
    expect(loginCmd).toBeDefined();
  });

  it('saves apiKey to config when --api-key flag is provided', async () => {
    loginCommand(program);

    const loginCmd = program.commands.find((cmd) => cmd.name() === 'login')!;
    await loginCmd.parseAsync(['node', 'koda', 'login', '--api-key', 'mykey123']);

    expect(configModule.setConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: 'mykey123',
      })
    );
  });

  it('saves apiUrl to config when --api-url flag is provided', async () => {
    loginCommand(program);

    const loginCmd = program.commands.find((cmd) => cmd.name() === 'login')!;
    await loginCmd.parseAsync([
      'node',
      'koda',
      'login',
      '--api-key',
      'mykey123',
      '--api-url',
      'http://custom:3100/api',
    ]);

    expect(configModule.setConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        apiUrl: 'http://custom:3100/api',
      })
    );
  });

  it('prints "Logged in successfully" when login completes', async () => {
    loginCommand(program);

    const loginCmd = program.commands.find((cmd) => cmd.name() === 'login')!;
    await loginCmd.parseAsync(['node', 'koda', 'login', '--api-key', 'mykey123']);

    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('Logged in successfully'));
  });

  it('requires --api-key flag', async () => {
    loginCommand(program);

    const loginCmd = program.commands.find((cmd) => cmd.name() === 'login')!;

    await expect(loginCmd.parseAsync(['node', 'koda', 'login'])).rejects.toThrow();
  });

  it('saves both apiKey and apiUrl when both flags are provided', async () => {
    loginCommand(program);

    const loginCmd = program.commands.find((cmd) => cmd.name() === 'login')!;
    await loginCmd.parseAsync([
      'node',
      'koda',
      'login',
      '--api-key',
      'mykey123',
      '--api-url',
      'http://custom:3100/api',
    ]);

    expect(configModule.setConfig).toHaveBeenCalledWith({
      apiKey: 'mykey123',
      apiUrl: 'http://custom:3100/api',
    });
  });
});
