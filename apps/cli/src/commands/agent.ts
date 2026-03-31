import { Command } from 'commander';
import { resolveContext, maskApiKey } from '../config';
import { configureClient } from '../client';
import { AgentService } from '../generated';
import { unwrap } from '../utils/api';
import { handleApiError } from '../utils/error';

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

        const client = configureClient(ctx.apiUrl, ctx.apiKey);
        const response = await AgentService.me(client);
        const agentData = unwrap(response);

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

        const client = configureClient(ctx.apiUrl, ctx.apiKey);
        const meResponse = await AgentService.me(client);
        const agentData = unwrap(meResponse);

        const pickupResponse = await AgentService.pickup(client, agentData.slug, ctx.projectSlug);
        const result = unwrap(pickupResponse);

        if (options.json) {
          console.log(JSON.stringify(result, null, 2));
          process.exit(0);
        }

        if (result === null) {
          console.log('No suitable tickets found for pickup.');
          process.exit(0);
        }

        const { ticket, matchScore, matchedCapabilities } = result;
        console.log(`Suggested ticket: #${ticket.number} — ${ticket.title}`);
        console.log(`Priority: ${ticket.priority} | Status: ${ticket.status}`);
        console.log(`Match score: ${matchScore} | Matched capabilities: ${matchedCapabilities.join(', ')}`);
        process.exit(0);
      } catch (err: unknown) {
        handleApiError(err);
      }
    });
}
