/**
 * VCS CLI Commands
 *
 * Note: Output strings are intentionally English-only as per CLI design standards for developer tools.
 * Translated error messages come from API responses and are handled by the error handler.
 * See .claude/rules/cli.md for rationale.
 */
import { Command } from 'commander';
import { resolveAuth } from '../utils/auth';
import { resolveContext } from '../config';
import { OpenAPI } from '../generated/core/OpenAPI';
import { table, error } from '../utils/output';
import { handleApiError } from '../utils/error';
import { VCS_MESSAGES } from './vcs-messages';
import {
  vcsControllerCreateConnection,
  vcsControllerGetConnection,
  vcsControllerDeleteConnection,
  vcsControllerUpdateConnection,
  vcsControllerTestConnection,
  vcsControllerSyncAll,
  vcsControllerSyncIssue,
  vcsControllerSyncPr,
} from '../generated/services.gen';

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
    .option('--sync-mode <mode>', 'Sync mode (off, polling, webhook)')
    .option('--json', 'Output as JSON')
    .action(async (options) => {
      try {
        // Validate required flags
        if (!options.provider || !options.owner || !options.repo || !options.token) {
          error(VCS_MESSAGES.MISSING_REQUIRED_OPTIONS);
          process.exit(3);
          return;
        }

        // Check authentication (using resolveAuth to validate configured keys)
        const auth = resolveAuth({});
        if (!auth.apiKey || !auth.apiUrl) {
          error(VCS_MESSAGES.MISSING_AUTH);
          process.exit(2);
          return;
        }

        // Get project slug from context
        const ctx = await resolveContext({ projectSlug: options.project });
        if (!ctx.projectSlug) {
          error(VCS_MESSAGES.MISSING_PROJECT);
          process.exit(3);
          return;
        }

        // Set API client configuration
        OpenAPI.BASE = auth.apiUrl.replace(/\/api\/?$/, '');
        OpenAPI.TOKEN = auth.apiKey;

        // Prepare request
        const requestBody = {
          provider: options.provider,
          repoOwner: options.owner,
          repoName: options.repo,
          token: options.token,
          syncMode: options.syncMode || 'off',
        };

        // Call API
        const response = await vcsControllerCreateConnection({
          slug: ctx.projectSlug,
          requestBody,
        });

        // Handle response envelope
        const data = ((response as unknown as Record<string, unknown>).data || (response as unknown as Record<string, unknown>)) as Record<string, unknown>;

        if (options.json) {
          console.log(JSON.stringify(data, null, 2));
        } else {
          const rows = formatConnection(data);
          console.log(VCS_MESSAGES.CONNECTED(ctx.projectSlug));
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
          error(VCS_MESSAGES.MISSING_AUTH);
          process.exit(2);
          return;
        }

        // Get project slug from context
        const ctx = await resolveContext({ projectSlug: options.project });
        if (!ctx.projectSlug) {
          error(VCS_MESSAGES.MISSING_PROJECT);
          process.exit(3);
          return;
        }

        // Set API client configuration
        OpenAPI.BASE = auth.apiUrl.replace(/\/api\/?$/, '');
        OpenAPI.TOKEN = auth.apiKey;

        // Call API
        const response = await vcsControllerGetConnection({ slug: ctx.projectSlug });
        const data = ((response as unknown as Record<string, unknown>).data || (response as unknown as Record<string, unknown>)) as Record<string, unknown>;

        if (options.json) {
          console.log(JSON.stringify(data, null, 2));
        } else {
          const rows = formatConnection(data);
          console.log(VCS_MESSAGES.STATUS_HEADER(ctx.projectSlug));
          table(['Field', 'Value'], rows);
        }

        process.exit(0);
      } catch (err: unknown) {
        const apiErr = err as { response?: { status?: number } };

        // Handle 404 specially for status command
        if (apiErr.response?.status === 404) {
          error(VCS_MESSAGES.NO_CONNECTION);
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
          error(VCS_MESSAGES.MISSING_AUTH);
          process.exit(2);
          return;
        }

        // Get project slug from context
        const ctx = await resolveContext({ projectSlug: options.project });
        if (!ctx.projectSlug) {
          error(VCS_MESSAGES.MISSING_PROJECT);
          process.exit(3);
          return;
        }

        // Set API client configuration
        OpenAPI.BASE = auth.apiUrl.replace(/\/api\/?$/, '');
        OpenAPI.TOKEN = auth.apiKey;

        // Call API
        await vcsControllerDeleteConnection({ slug: ctx.projectSlug });

        console.log(VCS_MESSAGES.DISCONNECTED(ctx.projectSlug));

        process.exit(0);
      } catch (err: unknown) {
        handleApiError(err);
      }
    });

  vcs
    .command('update')
    .option('--sync-mode <mode>', 'Sync mode (off, polling, webhook)')
    .option('--authors <authors>', 'Comma-separated list of allowed authors')
    .option('--polling-interval-ms <ms>', 'Polling interval in milliseconds')
    .option('--project <slug>', 'Project slug (uses config if not provided)')
    .action(async (options) => {
      try {
        // Check authentication
        const auth = resolveAuth({});
        if (!auth.apiKey || !auth.apiUrl) {
          error(VCS_MESSAGES.MISSING_AUTH);
          process.exit(2);
          return;
        }

        // Get project slug from context
        const ctx = await resolveContext({ projectSlug: options.project });
        if (!ctx.projectSlug) {
          error(VCS_MESSAGES.MISSING_PROJECT);
          process.exit(3);
          return;
        }

        // Set API client configuration
        OpenAPI.BASE = auth.apiUrl.replace(/\/api\/?$/, '');
        OpenAPI.TOKEN = auth.apiKey;

        // Build request body
        const requestBody: Record<string, unknown> = {};
        if (options.syncMode) {
          requestBody.syncMode = options.syncMode;
        }
        if (options.authors) {
          requestBody.allowedAuthors = String(options.authors)
            .split(',')
            .map((author) => author.trim())
            .filter(Boolean);
        }
        if (options.pollingIntervalMs) {
          requestBody.pollingIntervalMs = Number(options.pollingIntervalMs);
        }

        // Call API
        await vcsControllerUpdateConnection({
          slug: ctx.projectSlug,
          requestBody,
        });

        console.log(VCS_MESSAGES.SETTINGS_UPDATED(ctx.projectSlug));

        process.exit(0);
      } catch (err: unknown) {
        handleApiError(err);
      }
    });

  vcs
    .command('test')
    .option('--project <slug>', 'Project slug (uses config if not provided)')
    .action(async (options) => {
      try {
        // Check authentication
        const auth = resolveAuth({});
        if (!auth.apiKey || !auth.apiUrl) {
          error(VCS_MESSAGES.MISSING_AUTH);
          process.exit(2);
          return;
        }

        // Get project slug from context
        const ctx = await resolveContext({ projectSlug: options.project });
        if (!ctx.projectSlug) {
          error(VCS_MESSAGES.MISSING_PROJECT);
          process.exit(3);
          return;
        }

        // Set API client configuration
        OpenAPI.BASE = auth.apiUrl.replace(/\/api\/?$/, '');
        OpenAPI.TOKEN = auth.apiKey;

        // Call API
        const result = await vcsControllerTestConnection({
          slug: ctx.projectSlug,
        });

        if (result.ok) {
          console.log(VCS_MESSAGES.CONNECTION_OK);
        } else {
          error(result.error || VCS_MESSAGES.CONNECTION_TEST_FAILED);
          process.exit(1);
          return;
        }

        process.exit(0);
      } catch (err: unknown) {
        handleApiError(err);
      }
    });

  vcs
    .command('sync')
    .option('--project <slug>', 'Project slug (uses config if not provided)')
    .action(async (options) => {
      try {
        // Check authentication
        const auth = resolveAuth({});
        if (!auth.apiKey || !auth.apiUrl) {
          error(VCS_MESSAGES.MISSING_AUTH);
          process.exit(2);
          return;
        }

        // Get project slug from context
        const ctx = await resolveContext({ projectSlug: options.project });
        if (!ctx.projectSlug) {
          error(VCS_MESSAGES.MISSING_PROJECT);
          process.exit(3);
          return;
        }

        // Set API client configuration
        OpenAPI.BASE = auth.apiUrl.replace(/\/api\/?$/, '');
        OpenAPI.TOKEN = auth.apiKey;

        // Call API
        const result = await vcsControllerSyncAll({
          slug: ctx.projectSlug,
        });

        console.log(
          `Sync complete: created ${result.issuesSynced}, skipped ${result.issuesSkipped}`
        );

        process.exit(0);
      } catch (err: unknown) {
        handleApiError(err);
      }
    });

  vcs
    .command('import <issueNumber>')
    .option('--project <slug>', 'Project slug (uses config if not provided)')
    .action(async (issueNumberArg, options) => {
      try {
        // Validate issue number
        const issueNumber = parseInt(issueNumberArg, 10);
        if (isNaN(issueNumber)) {
          error(VCS_MESSAGES.INVALID_ISSUE_NUMBER);
          process.exit(1);
          return;
        }

        // Check authentication
        const auth = resolveAuth({});
        if (!auth.apiKey || !auth.apiUrl) {
          error(VCS_MESSAGES.MISSING_AUTH);
          process.exit(2);
          return;
        }

        // Get project slug from context
        const ctx = await resolveContext({ projectSlug: options.project });
        if (!ctx.projectSlug) {
          error(VCS_MESSAGES.MISSING_PROJECT);
          process.exit(3);
          return;
        }

        // Set API client configuration
        OpenAPI.BASE = auth.apiUrl.replace(/\/api\/?$/, '');
        OpenAPI.TOKEN = auth.apiKey;

        // Call API
        const result = await vcsControllerSyncIssue({
          slug: ctx.projectSlug,
          issueNumber: String(issueNumber),
        });

        const firstTicket = result.tickets[0];
        console.log(VCS_MESSAGES.ISSUE_IMPORTED(firstTicket?.ref || `${ctx.projectSlug}-${issueNumber}`));

        process.exit(0);
      } catch (err: unknown) {
        handleApiError(err);
      }
    });

  vcs
    .command('sync-pr')
    .description('Sync PR status for all active pull requests')
    .option('--project <slug>', 'Project slug (uses config if not provided)')
    .action(async (options) => {
      try {
        // Check authentication
        const auth = resolveAuth({});
        if (!auth.apiKey || !auth.apiUrl) {
          error(VCS_MESSAGES.MISSING_AUTH);
          process.exit(2);
          return;
        }

        // Get project slug from context
        const ctx = await resolveContext({ projectSlug: options.project });
        if (!ctx.projectSlug) {
          error(VCS_MESSAGES.MISSING_PROJECT);
          process.exit(3);
          return;
        }

        // Set API client configuration
        OpenAPI.BASE = auth.apiUrl.replace(/\/api\/?$/, '');
        OpenAPI.TOKEN = auth.apiKey;

        // Call API
        const result = await vcsControllerSyncPr({
          slug: ctx.projectSlug,
        });

        console.log(`PR sync complete: ${result.updated} PR(s) updated`);

        process.exit(0);
      } catch (err: unknown) {
        handleApiError(err);
      }
    });
}
