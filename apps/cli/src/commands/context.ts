import { Command } from 'commander';
import { resolveContext } from '../config';
import { OpenAPI } from '../generated/core/OpenAPI';
import {
  contextControllerGetContext,
  contextControllerQueryContext,
} from '../generated';
import { unwrap } from '../utils/api';
import { handleApiError } from '../utils/error';

export function contextCommand(program: Command): void {
  const ctx = program.command('context');
  ctx.description('Query project context (agent-facing)');

  ctx
    .command('get')
    .description('Get full project context by project ID')
    .requiredOption('--project-id <id>', 'Project UUID')
    .option('--json', 'Output as JSON')
    .action(async (options) => {
      try {
        const config = await resolveContext({});
        if (!config.apiKey || !config.apiUrl) {
          handleApiError(new Error('API key or URL not configured. Run: koda login --api-key <key>'), { configError: true });
        }

        OpenAPI.BASE = config.apiUrl.replace(/\/api\/?$/, '');
        OpenAPI.TOKEN = config.apiKey;

        const response = await contextControllerGetContext({ projectId: options.projectId });
        const data = unwrap<Record<string, unknown>>(response);

        console.log(JSON.stringify(data, null, 2));
        process.exit(0);
      } catch (err: unknown) {
        handleApiError(err, { notFoundMessage: `Project not found: ${options.projectId}` });
      }
    });

  ctx
    .command('query')
    .description('Query project context with a natural-language prompt')
    .requiredOption('--project-id <id>', 'Project UUID')
    .option('--query <text>', 'Natural-language query')
    .option('--intent <intent>', 'Query intent (e.g. plan, diagnose, review)')
    .option('--ticket-ids <ids>', 'Comma-separated ticket IDs to scope the query')
    .option('--token-budget <n>', 'Max token budget for the response', parseInt)
    .option('--json', 'Output as JSON')
    .action(async (options) => {
      try {
        const config = await resolveContext({});
        if (!config.apiKey || !config.apiUrl) {
          handleApiError(new Error('API key or URL not configured. Run: koda login --api-key <key>'), { configError: true });
        }

        OpenAPI.BASE = config.apiUrl.replace(/\/api\/?$/, '');
        OpenAPI.TOKEN = config.apiKey;

        const requestBody: Record<string, unknown> = {};
        if (options.query) requestBody['query'] = options.query;
        if (options.intent) requestBody['intent'] = options.intent;
        if (options.ticketIds) requestBody['ticketIds'] = (options.ticketIds as string).split(',').map((s: string) => s.trim()).filter(Boolean);
        if (options.tokenBudget) requestBody['tokenBudget'] = options.tokenBudget;

        const response = await contextControllerQueryContext({
          projectId: options.projectId,
          requestBody,
        });
        const data = unwrap<Record<string, unknown>>(response);

        console.log(JSON.stringify(data, null, 2));
        process.exit(0);
      } catch (err: unknown) {
        handleApiError(err, { notFoundMessage: `Project not found: ${options.projectId}` });
      }
    });
}
