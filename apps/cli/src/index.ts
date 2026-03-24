#!/usr/bin/env node

import { Command } from 'commander';
import { readFileSync } from 'fs';
import { join } from 'path';
import { loginCommand } from './commands/login';
import { configShow, configSet } from './commands/config';
import { projectCommand } from './commands/project';
import { ticketCommand } from './commands/ticket';
import { commentCommand } from './commands/comment';
import { agentCommand } from './commands/agent';
import { labelCommand } from './commands/label';
import { kbCommand } from './commands/kb';

// Read package.json to get version
let version = '0.1.0';
try {
  const packageJsonPath = join(__dirname, '../package.json');
  const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));
  version = packageJson.version;
} catch {
  // Use default version if package.json not found
}

const program = new Command();

program
  .name('koda')
  .description('CLI for Koda — dev ticket tracker')
  .version(version);

// Login command
program
  .command('login')
  .description('Save API credentials locally')
  .requiredOption('--api-key <key>', 'API key for authentication')
  .option('--api-url <url>', 'API URL (default: http://localhost:3100/api)')
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
