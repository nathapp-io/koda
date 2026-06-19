import { Command } from 'commander';
import { resolveContext } from '../config';
import { OpenAPI } from '../generated/core/OpenAPI';
import {
  adminControllerGetOutbox,
  adminControllerRetryOutboxEvent,
  sloDashboardControllerGetSloMetrics,
} from '../generated';
import { table } from '../utils/output';
import { unwrap } from '../utils/api';
import { handleApiError } from '../utils/error';

export function adminCommand(program: Command): void {
  const admin = program.command('admin');
  admin.description('Operator administration commands');

  const outbox = admin.command('outbox');
  outbox.description('Manage the outbox event queue');

  outbox
    .command('list')
    .description('List outbox events')
    .option('--status <status>', 'Filter by status (pending, failed, sent)')
    .option('--json', 'Output as JSON')
    .action(async (options) => {
      try {
        const ctx = await resolveContext({});
        if (!ctx.apiKey || !ctx.apiUrl) {
          handleApiError(new Error('API key or URL not configured. Run: koda login --api-key <key>'), { configError: true });
        }

        OpenAPI.BASE = ctx.apiUrl.replace(/\/api\/?$/, '');
        OpenAPI.TOKEN = ctx.apiKey;

        const response = await adminControllerGetOutbox({ status: options.status });
        const raw = unwrap<{ items?: Array<Record<string, unknown>> } | Array<Record<string, unknown>>>(response);
        const items: Array<Record<string, unknown>> = Array.isArray(raw)
          ? raw
          : ((raw as { items?: Array<Record<string, unknown>> }).items ?? []);

        if (options.json) {
          console.log(JSON.stringify(items, null, 2));
        } else {
          const rows = items.map((e) => [
            String(e['id'] ?? ''),
            String(e['eventType'] ?? e['type'] ?? ''),
            String(e['status'] ?? ''),
            String(e['createdAt'] ?? ''),
          ]);
          table(['ID', 'Type', 'Status', 'Created'], rows);
        }
        process.exit(0);
      } catch (err: unknown) {
        handleApiError(err);
      }
    });

  outbox
    .command('retry')
    .description('Retry a failed outbox event')
    .requiredOption('--event-id <id>', 'Outbox event ID to retry')
    .option('--json', 'Output as JSON')
    .action(async (options) => {
      try {
        const ctx = await resolveContext({});
        if (!ctx.apiKey || !ctx.apiUrl) {
          handleApiError(new Error('API key or URL not configured. Run: koda login --api-key <key>'), { configError: true });
        }

        OpenAPI.BASE = ctx.apiUrl.replace(/\/api\/?$/, '');
        OpenAPI.TOKEN = ctx.apiKey;

        const response = await adminControllerRetryOutboxEvent({ eventId: options.eventId });
        const data = unwrap<Record<string, unknown>>(response);

        if (options.json) {
          console.log(JSON.stringify(data, null, 2));
        } else {
          console.log(`Event '${options.eventId}' queued for retry.`);
        }
        process.exit(0);
      } catch (err: unknown) {
        handleApiError(err, { notFoundMessage: `Outbox event not found: ${options.eventId}` });
      }
    });

  admin
    .command('slos')
    .description('View SLO metrics dashboard')
    .option('--from <iso>', 'Start of time range (ISO 8601)')
    .option('--to <iso>', 'End of time range (ISO 8601)')
    .option('--json', 'Output as JSON')
    .action(async (options) => {
      try {
        const ctx = await resolveContext({});
        if (!ctx.apiKey || !ctx.apiUrl) {
          handleApiError(new Error('API key or URL not configured. Run: koda login --api-key <key>'), { configError: true });
        }

        OpenAPI.BASE = ctx.apiUrl.replace(/\/api\/?$/, '');
        OpenAPI.TOKEN = ctx.apiKey;

        const response = await sloDashboardControllerGetSloMetrics({ from: options.from, to: options.to });
        const data = unwrap<Record<string, unknown>>(response);

        if (options.json) {
          console.log(JSON.stringify(data, null, 2));
        } else {
          const metrics = Array.isArray(data) ? data : (data['metrics'] as Array<Record<string, unknown>>) ?? [data];
          const rows = metrics.map((m) => [
            String(m['name'] ?? m['metric'] ?? ''),
            String(m['value'] ?? ''),
            String(m['target'] ?? ''),
            String(m['status'] ?? ''),
          ]);
          table(['Metric', 'Value', 'Target', 'Status'], rows);
        }
        process.exit(0);
      } catch (err: unknown) {
        handleApiError(err);
      }
    });
}
