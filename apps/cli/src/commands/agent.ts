import { Command } from 'commander';
import { resolveContext } from '../config';
import { OpenAPI } from '../generated/core/OpenAPI';
import { agentsControllerFindMe, agentsControllerSuggestTicket } from '../generated';
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
}
