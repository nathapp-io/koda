import { Command } from 'commander';
import { ticketCommand } from './ticket';

describe('ticketCommand', () => {
  let program: Command;
  let consoleLogSpy: jest.SpyInstance;
  let processExitSpy: jest.SpyInstance;

  beforeEach(() => {
    program = new Command();
    consoleLogSpy = jest.spyOn(console, 'log').mockImplementation();
    processExitSpy = jest.spyOn(process, 'exit').mockImplementation(() => undefined as never);
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    processExitSpy.mockRestore();
  });

  it('registers ticket command', () => {
    ticketCommand(program);
    const ticketCmd = program.commands.find((cmd) => cmd.name() === 'ticket');
    expect(ticketCmd).toBeDefined();
  });

  it('registers list subcommand', () => {
    ticketCommand(program);
    const ticketCmd = program.commands.find((cmd) => cmd.name() === 'ticket');
    const listCmd = ticketCmd?.commands.find((cmd) => cmd.name() === 'list');
    expect(listCmd).toBeDefined();
  });

  it('registers show subcommand', () => {
    ticketCommand(program);
    const ticketCmd = program.commands.find((cmd) => cmd.name() === 'ticket');
    const showCmd = ticketCmd?.commands.find((cmd) => cmd.name() === 'show');
    expect(showCmd).toBeDefined();
  });

  it('description is set', () => {
    ticketCommand(program);
    const ticketCmd = program.commands.find((cmd) => cmd.name() === 'ticket');
    expect(ticketCmd?.description()).toBe('Manage tickets');
  });
});
