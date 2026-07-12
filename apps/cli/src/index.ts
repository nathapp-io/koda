#!/usr/bin/env node

import { Command } from 'commander';
import { readFileSync } from 'fs';
import { join, resolve } from 'path';
import { loginCommand } from './commands/login';
import { initCommand } from './commands/init';
import { configShow, configSet, configProfileListAction, configProfileAddAction, configProfileRemoveAction } from './commands/config';
import { getProfiles, setProfile, removeProfile } from './config';
import { projectCommand } from './commands/project';
import { ticketCommand } from './commands/ticket';
import { commentCommand } from './commands/comment';
import { agentCommand } from './commands/agent';
import { labelCommand } from './commands/label';
import { kbCommand } from './commands/kb';
import { evaluateCommand } from './commands/evaluate';
import { vcsCommand } from './commands/vcs';
import { webhookCommand } from './commands/webhook';
import { contextCommand } from './commands/context';
import { memoryCommand } from './commands/memory';
import { codeIntelCommand } from './commands/code-intel';
import { authCommand } from './commands/auth';
import { adminCommand } from './commands/admin';
import { ciWebhookCommand } from './commands/ci-webhook';
import { setJsonMode } from './utils/json-mode';

// Read package.json to get version
let version = '0.1.0';
try {
  const packageJsonPath = join(__dirname, '../package.json');
  const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));
  version = packageJson.version;
}
catch {
  // Use default version if package.json not found
}

const program = new Command();

program
  .name('koda')
  .description('CLI for Koda — dev ticket tracker')
  .version(version)
  .option('--cwd <path>', 'Working directory for project config discovery and init');

program.hook('preAction', (thisCommand) => {
  const globalOptions = thisCommand.optsWithGlobals() as { cwd?: string };
  if (!globalOptions.cwd) {
    return;
  }

  const targetCwd = resolve(globalOptions.cwd);
  try {
    process.chdir(targetCwd);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`Error: invalid --cwd path (${targetCwd}): ${errorMessage}`);
    process.exit(2);
  }
});

// --json is declared per-command, not globally, so handleApiError (called
// from ~160 sites without access to that command's local options) can't
// see it directly. Read it off the matched command here instead.
program.hook('preAction', (_thisCommand, actionCommand) => {
  const opts = actionCommand.opts() as { json?: boolean };
  setJsonMode(!!opts.json);
});

// Login command
program
  .command('login')
  .description('Save API credentials locally')
  .requiredOption('--api-key <key>', 'API key for authentication')
  .option('--api-url <url>', 'API URL (default: http://localhost:3100)')
  .action(async (options) => {
    try {
      const result = await loginCommand(
        options.apiKey,
        options.apiUrl,
        {}
      );
      console.log(result.message);
      process.exit(0);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`Error: ${errorMessage}`);
      process.exit(2);
    }
  });

// Init command
program
  .command('init')
  .description('Initialize .koda/config.json in working directory')
  .option('--project <slug>', 'Project slug')
  .option('--default-type <type>', 'Default ticket type')
  .option('--default-priority <priority>', 'Default ticket priority')
  .option('--api-key <key>', 'API key for authentication')
  .option('--api-url <url>', 'API URL (default: http://localhost:3100)')
  .action(async (options) => {
    await initCommand(options);
  });

// Config command
program
  .command('config')
  .description('Manage configuration')
  .addCommand(
    new Command('show')
      .description('Display current configuration')
      .action(() => {
        try {
          const config = configShow();
          console.log('API Key: ' + config.apiKey);
          console.log('API URL: ' + (config.apiUrl || '(not set)'));
          process.exit(0);
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          console.error(`Error: ${errorMessage}`);
          process.exit(2);
        }
      })
  )
  .addCommand(
    new Command('set')
      .description('Update configuration')
      .option('--api-key <key>', 'API key')
      .option('--api-url <url>', 'API URL')
      .action((options) => {
        try {
          if (!options.apiKey && !options.apiUrl) {
            throw new Error('Must provide at least one option: --api-key or --api-url');
          }
          const result = configSet({
            apiKey: options.apiKey,
            apiUrl: options.apiUrl,
          });
          console.log(result.message);
          process.exit(0);
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          console.error(`Error: ${errorMessage}`);
          process.exit(2);
        }
      })
  )
  .addCommand(
    new Command('profile')
      .description('Manage named API credential profiles')
      .addCommand(
        new Command('list')
          .description('List configured profiles')
          .action(() => {
            configProfileListAction({ getProfiles, setProfile, removeProfile });
          })
      )
      .addCommand(
        new Command('add')
          .description('Add or update a profile')
          .argument('<name>', 'Profile name')
          .requiredOption('--api-url <url>', 'API URL for this profile')
          .requiredOption('--api-key <key>', 'API key for this profile')
          .action((name, options) => {
            try {
              configProfileAddAction(name, options.apiUrl, options.apiKey, { getProfiles, setProfile, removeProfile });
              console.log(`Profile '${name}' saved.`);
              process.exit(0);
            } catch (error) {
              const errorMessage = error instanceof Error ? error.message : String(error);
              console.error(`Error: ${errorMessage}`);
              process.exit(2);
            }
          })
      )
      .addCommand(
        new Command('remove')
          .description('Remove a profile')
          .argument('<name>', 'Profile name')
          .action((name) => {
            configProfileRemoveAction(name, { getProfiles, setProfile, removeProfile });
            console.log(`Profile '${name}' removed.`);
            process.exit(0);
          })
      )
  );

// Version command
program
  .command('version')
  .description('Print CLI version')
  .action(() => {
    console.log(version);
    process.exit(0);
  });

// Project command
projectCommand(program);

// Ticket command
ticketCommand(program);

// Comment command
commentCommand(program);

// Agent command
agentCommand(program);

// Label command
labelCommand(program);

// KB command
kbCommand(program);

// Evaluate command
evaluateCommand(program);

// VCS command
vcsCommand(program);

// Webhook command
webhookCommand(program);

// Context command
contextCommand(program);

// Memory command
memoryCommand(program);

// Code-intel command
codeIntelCommand(program);

// Auth command
authCommand(program);

// Admin command
adminCommand(program);

// CI webhook command
ciWebhookCommand(program);

// Global error handling for uncaught exceptions
process.on('uncaughtException', (error: Error) => {
  console.error('Uncaught Exception:', error.message);
  process.exit(1);
});

// Global error handling for unhandled promise rejections
process.on('unhandledRejection', (reason: unknown) => {
  const message = reason instanceof Error ? reason.message : String(reason);
  console.error('Unhandled Rejection:', message);
  process.exit(1);
});

// Graceful shutdown on SIGINT (Ctrl+C)
process.on('SIGINT', () => {
  console.log('\nShutting down gracefully...');
  process.exit(0);
});

// Graceful shutdown on SIGTERM (kill signal)
process.on('SIGTERM', () => {
  console.log('\nShutting down gracefully...');
  process.exit(0);
});

program.parse(process.argv);

// Show help if no command provided
if (!process.argv.slice(2).length) {
  program.outputHelp();
}
