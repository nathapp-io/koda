import { Command } from 'commander';
import { resolveAuth } from '../utils/auth';
import { configureClient } from '../client';
import { CommentsService } from '../generated';
import { success, error } from '../utils/output';

export function commentCommand(program: Command): void {
  const comment = program.command('comment');

  comment
    .command('add <ref>')
    .description('Add a comment to a ticket')
    .requiredOption('--body <text>', 'Comment body text')
    .option('--type <type>', 'Comment type (verification, fix_report, review, general)', 'general')
    .option('--json', 'Output as JSON')
    .action(async (ref: string, options) => {
      try {
        const auth = resolveAuth({});

        if (!auth.apiKey || !auth.apiUrl) {
          error('API key or URL not configured. Run: koda login --api-key <key>');
          process.exit(2);
        }

        // Validate comment type
        const validTypes = ['verification', 'fix_report', 'review', 'general'];
        if (!validTypes.includes(options.type)) {
          error(`Invalid comment type: ${options.type}. Must be one of: ${validTypes.join(', ')}`);
          process.exit(3);
        }

        const client = configureClient(auth.apiUrl, auth.apiKey);
        const response = await CommentsService.add(client, ref, {
          body: options.body,
          type: options.type,
        });

        if (options.json) {
          console.log(JSON.stringify(response.data, null, 2));
        } else {
          success(`Comment added to ${ref}`);
          console.log(`ID: ${response.data.id}`);
          console.log(`Type: ${response.data.type}`);
          console.log(`Body: ${response.data.body}`);
        }

        process.exit(0);
      } catch (err) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const error_ = err as any;
        const statusCode = error_.response?.status;
        if (statusCode === 401 || statusCode === 403) {
          error('Unauthorized. Please check your API key.');
          process.exit(2);
        }
        if (statusCode === 404) {
          error(`Ticket not found: ${ref}`);
          process.exit(1);
        }
        if (statusCode === 400) {
          error(`Bad request: ${error_.response?.data?.message || error_.message}`);
          process.exit(3);
        }
        error(error_.message || 'Failed to add comment');
        process.exit(1);
      }
    });
}
