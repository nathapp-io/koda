import { Command } from 'commander';
import { resolveContext } from '../config';
import { OpenAPI } from '../generated/core/OpenAPI';
import { timelineControllerGetTimeline } from '../generated';
import { table } from '../utils/output';
import { unwrap } from '../utils/api';
import { handleApiError } from '../utils/error';

export function memoryCommand(program: Command): void {
  const memory = program.command('memory');
  memory.description('View project memory and timeline');

  memory
    .command('timeline')
    .description('List the event timeline for a project')
    .option('--project <slug>', 'Project slug')
    .option('--actor-id <id>', 'Filter by actor (user or agent) ID')
    .option('--ticket-id <id>', 'Filter by ticket ID')
    .option('--from <iso>', 'Start of time range (ISO 8601)')
    .option('--to <iso>', 'End of time range (ISO 8601)')
    .option('--limit <n>', 'Maximum number of events to return (default: 50)', '50')
    .option('--cursor <cursor>', 'Pagination cursor')
    .option('--json', 'Output as JSON')
    .action(async (options) => {
      try {
        const ctx = await resolveContext({ projectSlug: options.project });
        if (!ctx.projectSlug) {
          handleApiError(new Error('Project not configured. Run: koda init'), { configError: true });
        }
        if (!ctx.apiKey || !ctx.apiUrl) {
          handleApiError(new Error('API key or URL not configured. Run: koda login --api-key <key>'), { configError: true });
        }

        OpenAPI.BASE = ctx.apiUrl.replace(/\/api\/?$/, '');
        OpenAPI.TOKEN = ctx.apiKey;

        const response = await timelineControllerGetTimeline({
          slug: ctx.projectSlug,
          actorId: options.actorId,
          ticketId: options.ticketId,
          from: options.from,
          to: options.to,
          limit: options.limit,
          cursor: options.cursor,
        });
        const raw = unwrap<{ items?: Array<Record<string, unknown>> } | Array<Record<string, unknown>>>(response);
        const items: Array<Record<string, unknown>> = Array.isArray(raw)
          ? raw
          : ((raw as { items?: Array<Record<string, unknown>> }).items ?? []);

        if (options.json) {
          console.log(JSON.stringify(items, null, 2));
        } else {
          const rows = items.map((e) => [
            String(e['type'] ?? e['action'] ?? ''),
            String(e['actorId'] ?? e['actorUserId'] ?? e['actorAgentId'] ?? ''),
            String(e['ticketId'] ?? ''),
            String(e['createdAt'] ?? ''),
          ]);
          table(['Type', 'Actor', 'Ticket', 'Time'], rows);
        }
        process.exit(0);
      } catch (err: unknown) {
        handleApiError(err);
      }
    });
}
