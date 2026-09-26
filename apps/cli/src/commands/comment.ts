import { Command } from 'commander';
import {
  commentsControllerCreateFromHttp,
  commentsControllerListByTicketFromHttp,
  commentsControllerUpdateFromHttp,
  commentsControllerDeleteFromHttp,
} from '../generated';
import { success, error, table } from '../utils/output';
import { unwrap } from '../utils/api';
import { handleApiError } from '../utils/error';
import { withContext } from '../utils/context';

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
        const ctx = await withContext({ projectSlug: options.project });

        const validTypes = ['GENERAL', 'VERIFICATION', 'FIX_REPORT', 'REVIEW'];
        if (!validTypes.includes(options.type)) {
          error(`Invalid type ${options.type}. Valid values: ${validTypes.join(', ')}`);
          process.exit(3);
        }

        const response = await commentsControllerCreateFromHttp({
  body: {
            body: options.body,
            type: options.type,
          },
  path: { slug: ctx.projectSlug, ref }
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
        const ctx = await withContext({ projectSlug: options.project });

        const response = await commentsControllerListByTicketFromHttp({
  path: { slug: ctx.projectSlug, ref }
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
        await withContext({}, { requireProject: false });

        const response = await commentsControllerUpdateFromHttp({
  body: { body: options.body },
  path: { id: options.id }
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
        await withContext({}, { requireProject: false });

        const response = await commentsControllerDeleteFromHttp({ path: { id: options.id }});
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
