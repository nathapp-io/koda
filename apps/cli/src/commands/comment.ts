import { Command } from 'commander';
import { resolveContext } from '../config';
import { OpenAPI } from '../generated/core/OpenAPI';
import {
  commentsControllerCreateFromHttp,
  commentsControllerListByTicketFromHttp,
  commentsControllerUpdateFromHttp,
  commentsControllerDeleteFromHttp,
} from '../generated';
import { success, error, table } from '../utils/output';
import { unwrap } from '../utils/api';
import { handleApiError } from '../utils/error';

export function commentCommand(program: Command): void {
  const comment = program.command('comment');

  comment
    .command('add <ref>')
    .description('Add a comment to a ticket')
    .option('--project <slug>', 'Project slug')
    .requiredOption('--body <text>', 'Comment body text')
    .option('--type <type>', 'Comment type (GENERAL|VERIFICATION|FIX_REPORT|REVIEW)', 'GENERAL')
    .option('--json', 'Output as JSON')
    .action(async (ref: string, options) => {
      try {
        const ctx = await resolveContext({ projectSlug: options.project });

        if (!ctx.projectSlug) {
          error('Project not configured. Run: koda init');
          process.exit(2);
        }

        if (!ctx.apiKey) {
          error('API key or URL not configured. Run: koda login --api-key <key>');
          process.exit(2);
        }

        const validTypes = ['GENERAL', 'VERIFICATION', 'FIX_REPORT', 'REVIEW'];
        if (!validTypes.includes(options.type)) {
          error(`Invalid type ${options.type}. Valid values: ${validTypes.join(', ')}`);
          process.exit(3);
        }

        OpenAPI.BASE = ctx.apiUrl.replace(/\/api\/?$/, '');
        OpenAPI.TOKEN = ctx.apiKey;

        const response = await commentsControllerCreateFromHttp({
          slug: ctx.projectSlug,
          ref,
          requestBody: {
            body: options.body,
            type: options.type,
          },
        });
        const commentData = unwrap(response);

        if (options.json) {
          console.log(JSON.stringify(commentData, null, 2));
        } else {
          success(`Comment added to ${ref}`);
          console.log(`ID: ${(commentData as Record<string, unknown>).id}`);
          console.log(`Type: ${(commentData as Record<string, unknown>).type}`);
          console.log(`Body: ${(commentData as Record<string, unknown>).body}`);
        }

        process.exit(0);
      } catch (err: unknown) {
        handleApiError(err, { notFoundMessage: `Ticket not found: ${ref}` });
      }
    });

  comment
    .command('list <ref>')
    .description('List comments for a ticket')
    .option('--project <slug>', 'Project slug')
    .option('--json', 'Output as JSON')
    .action(async (ref: string, options) => {
      try {
        const ctx = await resolveContext({ projectSlug: options.project });

        if (!ctx.projectSlug) {
          error('Project not configured. Run: koda init');
          process.exit(2);
        }

        if (!ctx.apiKey) {
          error('API key or URL not configured. Run: koda login --api-key <key>');
          process.exit(2);
        }

        OpenAPI.BASE = ctx.apiUrl.replace(/\/api\/?$/, '');
        OpenAPI.TOKEN = ctx.apiKey;

        const response = await commentsControllerListByTicketFromHttp({
          slug: ctx.projectSlug,
          ref,
        });
        const data = unwrap<{ items?: Array<Record<string, unknown>> } | Array<Record<string, unknown>>>(response);
        const items: Array<Record<string, unknown>> = Array.isArray(data)
          ? data
          : ((data as { items?: Array<Record<string, unknown>> }).items ?? []);

        if (options.json) {
          console.log(JSON.stringify(items, null, 2));
        } else {
          const rows = items.map((c) => [
            String(c.id ?? ''),
            String(c.type ?? ''),
            String(c.body ?? ''),
          ]);
          table(['ID', 'Type', 'Body'], rows);
        }

        process.exit(0);
      } catch (err: unknown) {
        handleApiError(err, { notFoundMessage: `Ticket not found: ${ref}` });
      }
    });

  comment
    .command('update')
    .description('Update a comment by ID')
    .requiredOption('--id <id>', 'Comment ID')
    .requiredOption('--body <text>', 'Comment body text')
    .option('--json', 'Output as JSON')
    .action(async (options) => {
      try {
        const ctx = await resolveContext({});

        if (!ctx.apiKey) {
          error('API key or URL not configured. Run: koda login --api-key <key>');
          process.exit(2);
        }

        OpenAPI.BASE = ctx.apiUrl.replace(/\/api\/?$/, '');
        OpenAPI.TOKEN = ctx.apiKey;

        const response = await commentsControllerUpdateFromHttp({
          id: options.id,
          requestBody: { body: options.body },
        });
        const updated = unwrap<Record<string, unknown>>(response);

        if (options.json) {
          console.log(JSON.stringify(updated, null, 2));
        } else {
          success(`Comment '${options.id}' updated.`);
        }

        process.exit(0);
      } catch (err: unknown) {
        handleApiError(err, { notFoundMessage: `Comment not found: ${options.id}` });
      }
    });

  comment
    .command('delete')
    .description('Delete a comment by ID')
    .requiredOption('--id <id>', 'Comment ID')
    .option('--force', 'Confirm deletion')
    .option('--json', 'Output as JSON')
    .action(async (options) => {
      if (!options.force) {
        error('Use --force to confirm deletion');
        process.exit(1);
      }

      try {
        const ctx = await resolveContext({});

        if (!ctx.apiKey) {
          error('API key or URL not configured. Run: koda login --api-key <key>');
          process.exit(2);
        }

        OpenAPI.BASE = ctx.apiUrl.replace(/\/api\/?$/, '');
        OpenAPI.TOKEN = ctx.apiKey;

        const response = await commentsControllerDeleteFromHttp({ id: options.id });
        const deleted = unwrap<Record<string, unknown> | undefined>(response);

        if (options.json) {
          console.log(JSON.stringify(deleted ?? { id: options.id, deleted: true }, null, 2));
        } else {
          success(`Comment '${options.id}' deleted.`);
        }

        process.exit(0);
      } catch (err: unknown) {
        handleApiError(err, { notFoundMessage: `Comment not found: ${options.id}` });
      }
    });
}
