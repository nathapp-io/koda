jest.mock('chalk', () => ({
  cyan: { bold: (s: string) => s }, gray: (s: string) => s, green: (s: string) => s, red: (s: string) => s, yellow: (s: string) => s,
}));
jest.mock('conf', () => jest.fn(() => ({ get: jest.fn(() => ''), set: jest.fn() })));
jest.mock('../generated', () => ({}));
jest.mock('../config', () => ({ resolveContext: jest.fn() }));

import { Command } from 'commander';
import { fleetCommand } from './fleet';

describe('fleetCommand', () => {
  it('registers the retained fleet subcommands without approval', () => {
    const program = new Command();
    fleetCommand(program);
    const fleet = program.commands.find((c) => c.name() === 'fleet');
    expect(fleet?.commands.map((c) => c.name()).sort()).toEqual(['analytics', 'budget', 'dispatch', 'drift-check', 'ingest', 'job', 'nax-files', 'repo', 'runner', 'schedule', 'status']);
  });

  it('rejects fleet approval as an unknown command', () => {
    const program = new Command();
    program.exitOverride();
    fleetCommand(program);

    expect(() => program.parse(['node', 'koda', 'fleet', 'approval'])).toThrow(
      expect.objectContaining({ code: 'commander.unknownCommand' }),
    );
  });
});
