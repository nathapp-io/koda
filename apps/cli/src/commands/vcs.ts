import { Command } from 'commander';
import { resolveAuth } from '../utils/auth';
import { OpenAPI } from '../generated/core/OpenAPI';
import { table, error } from '../utils/output';
import { handleApiError } from '../utils/error';

/**
 * VCS command stub - to be implemented
 * Will support: vcs connect, vcs status, vcs disconnect
 */
export function vcsCommand(program: Command): void {
  const vcs = program.command('vcs');

  vcs
    .command('connect')
    .requiredOption('--provider <provider>', 'VCS provider (e.g., github)')
    .requiredOption('--owner <owner>', 'Repository owner')
    .requiredOption('--repo <repo>', 'Repository name')
    .requiredOption('--token <token>', 'API token for provider')
    .option('--project <slug>', 'Project slug (uses config if not provided)')
    .option('--sync-mode <mode>', 'Sync mode (polling, webhook, manual)')
    .option('--json', 'Output as JSON')
    .action(async (options) => {
      // To be implemented in next session
      error('VCS connect not yet implemented');
      process.exit(1);
    });

  vcs
    .command('status')
    .option('--project <slug>', 'Project slug (uses config if not provided)')
    .option('--json', 'Output as JSON')
    .action(async (options) => {
      // To be implemented in next session
      error('VCS status not yet implemented');
      process.exit(1);
    });

  vcs
    .command('disconnect')
    .option('--project <slug>', 'Project slug (uses config if not provided)')
    .action(async (options) => {
      // To be implemented in next session
      error('VCS disconnect not yet implemented');
      process.exit(1);
    });
}
