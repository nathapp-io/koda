import { Command } from 'commander';
import { resolveAuth } from '../utils/auth';
import { configureClient } from '../client';
import { AgentService } from '../generated';
import { error } from '../utils/output';
import { unwrap } from '../utils/api';
import { handleApiError } from '../utils/error';

function maskApiKey(apiKey: string): string {
  if (apiKey.length <= 8) {
    return '****';
  }
  return apiKey.substring(0, 4) + '*'.repeat(apiKey.length - 8) + apiKey.substring(apiKey.length - 4);
}

export function agentCommand(program: Command): void {
  const agent = program.command('agent');

  agent
    .command('me')
    .description('Display current authenticated agent profile')
    .option('--json', 'Output as JSON')
    .action(async (options) => {
      try {
        const auth = resolveAuth({});

        if (!auth.apiKey || !auth.apiUrl) {
          error('API key or URL not configured. Run: koda login --api-key <key>');
          process.exit(2);
          return;
        }

        const client = configureClient(auth.apiUrl, auth.apiKey);
        const response = await AgentService.me(client);
        const agentData = unwrap(response);

        if (options.json) {
          console.log(JSON.stringify(agentData, null, 2));
        } else {
          console.log(`Name: ${agentData.name}`);
          console.log(`Slug: ${agentData.slug}`);
          console.log(`API Key: ${maskApiKey(agentData.apiKey)}`);
        }

        process.exit(0);
      } catch (err: unknown) {
        handleApiError(err);
      }
    });
}
