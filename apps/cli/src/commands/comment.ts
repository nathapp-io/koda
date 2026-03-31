import { Command } from 'commander';
import { resolveContext } from '../config';
import { OpenAPI } from '../generated/core/OpenAPI';
import { commentsControllerCreateFromHttp } from '../generated';
import { success, error } from '../utils/output';
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
}
