import { Command } from 'commander';
import { resolveAuth } from '../utils/auth';
import { resolveContext } from '../config';
import { OpenAPI } from '../generated/core/OpenAPI';
import { table, error } from '../utils/output';
import { handleApiError } from '../utils/error';
import {
  vcsControllerCreateConnection,
  vcsControllerGetConnection,
  vcsControllerDeleteConnection,
} from '../vcs-client.stub';

/**
 * Format a connection for display
 */
function formatConnection(conn: Record<string, unknown>): string[][] {
  const rows: string[][] = [];

  if (conn.provider) rows.push(['Provider', String(conn.provider)]);
  if (conn.repoOwner) rows.push(['Repository Owner', String(conn.repoOwner)]);
  if (conn.repoName) rows.push(['Repository Name', String(conn.repoName)]);
  if (conn.syncMode) rows.push(['Sync Mode', String(conn.syncMode)]);
  if (conn.isActive !== undefined) rows.push(['Active', String(conn.isActive)]);
  if (conn.lastSyncedAt)
    rows.push(['Last Synced At', new Date(conn.lastSyncedAt as string).toISOString()]);
  if (conn.createdAt) rows.push(['Created At', new Date(conn.createdAt as string).toISOString()]);

  return rows;
}

export function vcsCommand(program: Command): void {
  const vcs = program.command('vcs');

  vcs
    .command('connect')
    .option('--provider <provider>', 'VCS provider (e.g., github)')
    .option('--owner <owner>', 'Repository owner')
    .option('--repo <repo>', 'Repository name')
    .option('--token <token>', 'API token for provider')
    .option('--project <slug>', 'Project slug (uses config if not provided)')
    .option('--sync-mode <mode>', 'Sync mode (polling, webhook, manual)')
    .option('--json', 'Output as JSON')
    .action(async (options) => {
      try {
        // Validate required flags
        if (!options.provider || !options.owner || !options.repo || !options.token) {
          error('Missing required options: --provider, --owner, --repo, --token');
          process.exit(3);
          return;
        }

        // Check authentication (using resolveAuth to validate configured keys)
        const auth = resolveAuth({});
        if (!auth.apiKey || !auth.apiUrl) {
          error('API key or URL not configured. Run: koda login --api-key <key>');
          process.exit(2);
          return;
        }

        // Get project slug from context
        const ctx = await resolveContext({ projectSlug: options.project });
        if (!ctx.projectSlug) {
          error('Project slug not specified. Use --project flag or set via config');
          process.exit(3);
          return;
        }

        // Set API client configuration
        OpenAPI.BASE = auth.apiUrl.replace(/\/api\/?$/, '');
        OpenAPI.TOKEN = auth.apiKey;

        // Prepare request
        const requestBody = {
          provider: options.provider,
          token: options.token,
          repoUrl: `${options.owner}/${options.repo}`,
          syncMode: options.syncMode || 'polling',
        };

        // Call API
        const response = await vcsControllerCreateConnection({
          slug: ctx.projectSlug,
          requestBody,
        });

        // Handle response
        const data = (response as any).data || response;

        if (options.json) {
          console.log(JSON.stringify(data, null, 2));
        } else {
          const rows = formatConnection(data);
          console.log(`\nVCS connection established for project ${ctx.projectSlug}:`);
          table(['Field', 'Value'], rows);
        }

        process.exit(0);
      } catch (err: unknown) {
        handleApiError(err);
      }
    });

  vcs
    .command('status')
    .option('--project <slug>', 'Project slug (uses config if not provided)')
    .option('--json', 'Output as JSON')
    .action(async (options) => {
      try {
        // Check authentication (using resolveAuth to validate configured keys)
        const auth = resolveAuth({});
        if (!auth.apiKey || !auth.apiUrl) {
          error('API key or URL not configured. Run: koda login --api-key <key>');
          process.exit(2);
          return;
        }

        // Get project slug from context
        const ctx = await resolveContext({ projectSlug: options.project });
        if (!ctx.projectSlug) {
          error('Project slug not specified. Use --project flag or set via config');
          process.exit(3);
          return;
        }

        // Set API client configuration
        OpenAPI.BASE = auth.apiUrl.replace(/\/api\/?$/, '');
        OpenAPI.TOKEN = auth.apiKey;

        // Call API
        const response = await vcsControllerGetConnection({ slug: ctx.projectSlug });
        const data = (response as any).data || response;

        if (options.json) {
          console.log(JSON.stringify(data, null, 2));
        } else {
          const rows = formatConnection(data);
          console.log(`\nVCS Connection status for project ${ctx.projectSlug}:`);
          table(['Field', 'Value'], rows);
        }

        process.exit(0);
      } catch (err: unknown) {
        const apiErr = err as any;

        // Handle 404 specially for status command
        if (apiErr.response?.status === 404) {
          error('No VCS connection configured');
          process.exit(1);
          return;
        }

        handleApiError(err);
      }
    });

  vcs
    .command('disconnect')
    .option('--project <slug>', 'Project slug (uses config if not provided)')
    .action(async (options) => {
      try {
        // Check authentication (using resolveAuth to validate configured keys)
        const auth = resolveAuth({});
        if (!auth.apiKey || !auth.apiUrl) {
          error('API key or URL not configured. Run: koda login --api-key <key>');
          process.exit(2);
          return;
        }

        // Get project slug from context
        const ctx = await resolveContext({ projectSlug: options.project });
        if (!ctx.projectSlug) {
          error('Project slug not specified. Use --project flag or set via config');
          process.exit(3);
          return;
        }

        // Set API client configuration
        OpenAPI.BASE = auth.apiUrl.replace(/\/api\/?$/, '');
        OpenAPI.TOKEN = auth.apiKey;

        // Call API
        await vcsControllerDeleteConnection({ slug: ctx.projectSlug });

        console.log(`VCS connection disconnected for project ${ctx.projectSlug}`);

        process.exit(0);
      } catch (err: unknown) {
        handleApiError(err);
      }
    });
}
