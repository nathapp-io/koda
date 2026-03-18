#!/usr/bin/env node
import { Command } from 'commander';
import { version } from '../package.json';
import { loginCommand } from './commands/login';
import { configCommand } from './commands/config';
import { projectCommand } from './commands/project';
import { ticketCommand } from './commands/ticket';
import { commentCommand } from './commands/comment';
import { agentCommand } from './commands/agent';
import { versionCommand } from './commands/version';

export const program = new Command();

program
  .name('koda')
  .description('Koda — dev ticket tracker CLI')
  .version(version);

// Register all subcommands
loginCommand(program);
configCommand(program);
projectCommand(program);
ticketCommand(program);
commentCommand(program);
agentCommand(program);
versionCommand(program);

// Only parse arguments when this is the main module (not imported in tests)
if (require.main === module) {
  program.parse(process.argv);
}
