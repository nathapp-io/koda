#!/usr/bin/env node

import { Command } from 'commander';
import { readFileSync } from 'fs';
import { join } from 'path';
import { loginCommand } from './commands/login';
import { configShow, configSet } from './commands/config';
import { projectCommand } from './commands/project';
import { commentCommand } from './commands/comment';
import { agentCommand } from './commands/agent';

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
          console.log('API URL: ' + config.apiUrl || '(not set)');
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

// Project command
projectCommand(program);

// Comment command
commentCommand(program);

// Agent command
agentCommand(program);

program.parse(process.argv);

// Show help if no command provided
if (!process.argv.slice(2).length) {
  program.outputHelp();
}
