import { Command } from 'commander';
import {
  contextControllerGetContext,
  contextControllerQueryContext,
} from '../generated';
import { unwrap } from '../utils/api';
import { handleApiError } from '../utils/error';
import { withContext } from '../utils/context';

export function contextCommand(program: Command): void {
  const ctx = program.command('context');
  ctx.description('Query project context (agent-facing)');

  ctx
    .command('get')
    .description('Get full project context by project slug')
    .option('--project <slug>', 'Project slug')
    .option('--json', 'Output as JSON')
    .action(async (options) => {
      try {
        const context = await withContext({ projectSlug: options.project });

        const response = await contextControllerGetContext({ slug: context.projectSlug });
        const data = unwrap<Record<string, unknown>>(response);

        console.log(JSON.stringify(data, null, 2));
        process.exit(0);
      } catch (err: unknown) {
        handleApiError(err, { notFoundMessage: `Project not found: ${options.project}` });
      }
    });

  ctx
    .command('query')
    .description('Query project context with a natural-language prompt')
    .option('--project <slug>', 'Project slug')
    .option('--query <text>', 'Natural-language query')
    .option('--intent <intent>', 'Query intent (e.g. plan, diagnose, review)')
    .option('--ticket-ids <ids>', 'Comma-separated ticket IDs to scope the query')
    .option('--token-budget <n>', 'Max token budget for the response', parseInt)
    .option('--json', 'Output as JSON')
    .action(async (options) => {
      try {
        const context = await withContext({ projectSlug: options.project });

        const requestBody: Record<string, unknown> = {};
        if (options.query) requestBody['query'] = options.query;
        if (options.intent) requestBody['intent'] = options.intent;
        if (options.ticketIds) requestBody['ticketIds'] = (options.ticketIds as string).split(',').map((s: string) => s.trim()).filter(Boolean);
        if (options.tokenBudget) requestBody['tokenBudget'] = options.tokenBudget;

        const response = await contextControllerQueryContext({
          slug: context.projectSlug,
          requestBody,
        });
        const data = unwrap<Record<string, unknown>>(response);

        console.log(JSON.stringify(data, null, 2));
        process.exit(0);
      } catch (err: unknown) {
        handleApiError(err, { notFoundMessage: `Project not found: ${options.project}` });
      }
    });
}
