import { Command } from 'commander';
import { resolveContext } from '../config';
import { OpenAPI } from '../generated/core/OpenAPI';
import {
  webhookControllerRegister,
  webhookControllerList,
  webhookControllerRemove,
} from '../generated';
import { table } from '../utils/output';
import { unwrap } from '../utils/api';
import { handleApiError } from '../utils/error';

export function webhookCommand(program: Command): void {
  const webhook = program.command('webhook');
  webhook.description('Manage outbound webhooks');

  webhook
    .command('create')
    .description('Register a webhook for a project')
    .option('--project <slug>', 'Project slug')
    .requiredOption('--url <url>', 'Webhook endpoint URL')
    .option('--secret <secret>', 'Signing secret (optional)')
    .option(
      '--events <events>',
      'Comma-separated event types (default: STATUS_CHANGE)',
      'STATUS_CHANGE',
    )
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

        const events = (options.events as string).split(',').map((e: string) => e.trim()).filter(Boolean);
        const response = await webhookControllerRegister({
          slug: ctx.projectSlug,
          requestBody: { url: options.url, secret: options.secret, events },
        });
        const data = unwrap<{ id: string; url: string; events: string[] }>(response);

        if (options.json) {
          console.log(JSON.stringify(data, null, 2));
        } else {
          const rows = [
            ['ID', data.id],
            ['URL', data.url],
            ['Events', (data.events ?? []).join(', ')],
          ];
          table(['Field', 'Value'], rows);
        }
        process.exit(0);
      } catch (err: unknown) {
        handleApiError(err);
      }
    });

  webhook
    .command('list')
    .description('List webhooks for a project')
    .option('--project <slug>', 'Project slug')
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

        const response = await webhookControllerList({ slug: ctx.projectSlug });
        const raw = unwrap<{ items?: Array<Record<string, unknown>> } | Array<Record<string, unknown>>>(response);
        const items: Array<Record<string, unknown>> = Array.isArray(raw)
          ? raw
          : ((raw as { items?: Array<Record<string, unknown>> }).items ?? []);

        if (options.json) {
          console.log(JSON.stringify(items, null, 2));
        } else {
          const rows = items.map((w) => [
            String(w['id'] ?? ''),
            String(w['url'] ?? ''),
            Array.isArray(w['events']) ? (w['events'] as string[]).join(', ') : String(w['events'] ?? ''),
          ]);
          table(['ID', 'URL', 'Events'], rows);
        }
        process.exit(0);
      } catch (err: unknown) {
        handleApiError(err);
      }
    });

  webhook
    .command('delete')
    .description('Delete a webhook by ID')
    .requiredOption('--id <id>', 'Webhook ID')
    .option('--json', 'Output as JSON')
    .action(async (options) => {
      try {
        const ctx = await resolveContext({});
        if (!ctx.apiKey || !ctx.apiUrl) {
          handleApiError(new Error('API key or URL not configured. Run: koda login --api-key <key>'), { configError: true });
        }

        OpenAPI.BASE = ctx.apiUrl.replace(/\/api\/?$/, '');
        OpenAPI.TOKEN = ctx.apiKey;

        await webhookControllerRemove({ id: options.id });

        if (options.json) {
          console.log(JSON.stringify({ deleted: true, id: options.id }));
        } else {
          console.log(`Webhook '${options.id}' deleted.`);
        }
        process.exit(0);
      } catch (err: unknown) {
        handleApiError(err, { notFoundMessage: `Webhook not found: ${options.id}` });
      }
    });
}
