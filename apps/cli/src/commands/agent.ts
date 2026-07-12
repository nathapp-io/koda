import { Command } from 'commander';
import { resolveContext } from '../config';
import { OpenAPI } from '../generated/core/OpenAPI';
import {
  agentsControllerFindMe,
  agentsControllerSuggestTicket,
  agentsControllerFindAll,
  agentsControllerGenerateApiKey,
  agentsControllerUpdate,
  agentsControllerRemove,
  agentsControllerRotateApiKey,
} from '../generated';
import { table } from '../utils/output';
import { unwrap } from '../utils/api';
import { handleApiError } from '../utils/error';

function maskApiKey(apiKey: string): string {
  if (apiKey.length <= 8) {
    return '****';
  }
  return apiKey.substring(0, 4) + '****' + apiKey.substring(apiKey.length - 4);
}

export function agentCommand(program: Command): void {
  const agent = program.command('agent');

  agent
    .command('me')
    .description('Display current authenticated agent profile')
    .option('--json', 'Output as JSON')
    .action(async (options) => {
      try {
        const ctx = await resolveContext({});

        if (!ctx.apiKey || !ctx.apiUrl) {
          handleApiError(new Error('API key or URL not configured. Run: koda login --api-key <key>'), { configError: true });
        }

        OpenAPI.BASE = ctx.apiUrl.replace(/\/api\/?$/, '');
        OpenAPI.TOKEN = ctx.apiKey;

        const response = await agentsControllerFindMe();
        const agentData = unwrap<{ name: string; slug: string; apiKey?: string }>(response);

        if (options.json) {
          console.log(JSON.stringify(agentData, null, 2));
        } else {
          console.log(`Name: ${agentData.name}`);
          console.log(`Slug: ${agentData.slug}`);
          const apiKeyOutput = agentData.apiKey ? maskApiKey(agentData.apiKey) : '(stored as hash — not recoverable)';
          console.log(`API Key: ${apiKeyOutput}`);
        }

        process.exit(0);
      } catch (err: unknown) {
        handleApiError(err);
      }
    });

  agent
    .command('pickup')
    .description('Suggest the best ticket for this agent to pick up')
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

        const meResponse = await agentsControllerFindMe();
        const agentData = unwrap<{ name: string; slug: string; apiKey?: string }>(meResponse);

        const pickupResponse = await agentsControllerSuggestTicket({ slug: agentData.slug, project: ctx.projectSlug });
        const result = unwrap(pickupResponse);

        if (options.json) {
          console.log(JSON.stringify(result, null, 2));
          process.exit(0);
        }

        if (result === null) {
          console.log('No suitable tickets found for pickup.');
          process.exit(0);
        }

        const { ticket, matchScore, matchedCapabilities } = result as {
          ticket: { number: number; title: string; priority: string; status: string };
          matchScore: number;
          matchedCapabilities: string[];
        };
        console.log(`Suggested ticket: #${ticket.number} — ${ticket.title}`);
        console.log(`Priority: ${ticket.priority} | Status: ${ticket.status}`);
        console.log(`Match score: ${matchScore} | Matched capabilities: ${matchedCapabilities.join(', ')}`);
        process.exit(0);
      } catch (err: unknown) {
        handleApiError(err);
      }
    });

  agent
    .command('list')
    .description('List all agents (admin only)')
    .option('--json', 'Output as JSON')
    .action(async (options) => {
      try {
        const ctx = await resolveContext({});

        if (!ctx.apiKey || !ctx.apiUrl) {
          handleApiError(new Error('API key or URL not configured. Run: koda login --api-key <key>'), { configError: true });
        }

        OpenAPI.BASE = ctx.apiUrl.replace(/\/api\/?$/, '');
        OpenAPI.TOKEN = ctx.apiKey;

        const response = await agentsControllerFindAll();
        const raw = unwrap<{ items?: Array<Record<string, unknown>> } | Array<Record<string, unknown>>>(response);
        const items: Array<Record<string, unknown>> = Array.isArray(raw)
          ? raw
          : ((raw as { items?: Array<Record<string, unknown>> }).items ?? []);

        if (options.json) {
          console.log(JSON.stringify(items, null, 2));
        } else {
          const rows = items.map((a) => [
            String(a['name'] ?? ''),
            String(a['slug'] ?? ''),
            String(a['status'] ?? ''),
            String(a['maxConcurrentTickets'] ?? ''),
          ]);
          table(['Name', 'Slug', 'Status', 'Max Tickets'], rows);
        }
        process.exit(0);
      } catch (err: unknown) {
        handleApiError(err);
      }
    });

  agent
    .command('create')
    .description('Create an agent and generate its API key (admin only)')
    .requiredOption('--name <name>', 'Agent name')
    .option('--slug <slug>', 'Agent slug (defaults to a slugified name)')
    .option('--roles <roles>', 'Comma-separated list of roles (e.g. DEVELOPER,AGENT)')
    .option('--max-concurrent-tickets <n>', 'Max concurrent tickets this agent can handle')
    .option('--json', 'Output as JSON')
    .action(async (options) => {
      try {
        const ctx = await resolveContext({});

        if (!ctx.apiKey || !ctx.apiUrl) {
          handleApiError(new Error('API key or URL not configured. Run: koda login --api-key <key>'), { configError: true });
        }

        OpenAPI.BASE = ctx.apiUrl.replace(/\/api\/?$/, '');
        OpenAPI.TOKEN = ctx.apiKey;

        const response = await agentsControllerGenerateApiKey({
          requestBody: {
            name: options.name,
            slug: options.slug,
            roles: options.roles ? String(options.roles).split(',').map((r: string) => r.trim()).filter(Boolean) : [],
            maxConcurrentTickets: options.maxConcurrentTickets !== undefined ? Number(options.maxConcurrentTickets) : undefined,
          },
        });
        const created = unwrap<{ name: string; slug: string; apiKey?: string }>(response);

        if (options.json) {
          console.log(JSON.stringify(created, null, 2));
        } else {
          console.log(`Agent created: ${created.name} (${created.slug})`);
          if (created.apiKey) {
            console.log(`API Key: ${created.apiKey}`);
            console.log('Store this key now — it will not be shown again.');
          }
        }
        process.exit(0);
      } catch (err: unknown) {
        handleApiError(err);
      }
    });

  agent
    .command('update')
    .description('Update an agent (admin only)')
    .argument('<slug>', 'Agent slug')
    .option('--name <name>', 'New agent name')
    .option('--status <status>', 'New status: ACTIVE, PAUSED, or OFFLINE')
    .option('--max-concurrent-tickets <n>', 'New max concurrent tickets')
    .option('--json', 'Output as JSON')
    .action(async (slug: string, options) => {
      try {
        const ctx = await resolveContext({});

        if (!ctx.apiKey || !ctx.apiUrl) {
          handleApiError(new Error('API key or URL not configured. Run: koda login --api-key <key>'), { configError: true });
        }

        OpenAPI.BASE = ctx.apiUrl.replace(/\/api\/?$/, '');
        OpenAPI.TOKEN = ctx.apiKey;

        const response = await agentsControllerUpdate({
          slug,
          requestBody: {
            name: options.name,
            status: options.status,
            maxConcurrentTickets: options.maxConcurrentTickets !== undefined ? Number(options.maxConcurrentTickets) : undefined,
          },
        });
        const updated = unwrap(response);

        if (options.json) {
          console.log(JSON.stringify(updated, null, 2));
        } else {
          console.log(`Agent '${slug}' updated.`);
        }
        process.exit(0);
      } catch (err: unknown) {
        handleApiError(err, { notFoundMessage: `Agent not found: ${slug}` });
      }
    });

  agent
    .command('rotate-key')
    .description('Rotate an agent API key (admin only)')
    .argument('<slug>', 'Agent slug')
    .option('--json', 'Output as JSON')
    .action(async (slug: string, options) => {
      try {
        const ctx = await resolveContext({});

        if (!ctx.apiKey || !ctx.apiUrl) {
          handleApiError(new Error('API key or URL not configured. Run: koda login --api-key <key>'), { configError: true });
        }

        OpenAPI.BASE = ctx.apiUrl.replace(/\/api\/?$/, '');
        OpenAPI.TOKEN = ctx.apiKey;

        const response = await agentsControllerRotateApiKey({ slug });
        const result = unwrap<{ apiKey?: string }>(response);

        if (options.json) {
          console.log(JSON.stringify(result, null, 2));
        } else {
          console.log(`API key rotated for '${slug}'.`);
          if (result.apiKey) {
            console.log(`New API Key: ${result.apiKey}`);
            console.log('Store this key now — it will not be shown again.');
          }
        }
        process.exit(0);
      } catch (err: unknown) {
        handleApiError(err, { notFoundMessage: `Agent not found: ${slug}` });
      }
    });

  agent
    .command('delete')
    .description('Delete (soft-delete) an agent (admin only)')
    .argument('<slug>', 'Agent slug')
    .action(async (slug: string) => {
      try {
        const ctx = await resolveContext({});

        if (!ctx.apiKey || !ctx.apiUrl) {
          handleApiError(new Error('API key or URL not configured. Run: koda login --api-key <key>'), { configError: true });
        }

        OpenAPI.BASE = ctx.apiUrl.replace(/\/api\/?$/, '');
        OpenAPI.TOKEN = ctx.apiKey;

        await agentsControllerRemove({ slug });
        console.log(`Agent '${slug}' deleted.`);
        process.exit(0);
      } catch (err: unknown) {
        handleApiError(err, { notFoundMessage: `Agent not found: ${slug}` });
      }
    });
}
