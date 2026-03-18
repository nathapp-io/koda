import { Command } from 'commander';
import { resolveAuth } from '../utils/auth';
import { configureClient } from '../client';
import { AgentService } from '../generated';
import { error } from '../utils/output';

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
        }

        const client = configureClient(auth.apiUrl, auth.apiKey);
        const response = await AgentService.me(client);

        if (options.json) {
          console.log(JSON.stringify(response.data, null, 2));
        } else {
          console.log(`Name: ${response.data.name}`);
          console.log(`Slug: ${response.data.slug}`);
          console.log(`API Key: ${maskApiKey(response.data.apiKey)}`);
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
        error(error_.message || 'Failed to fetch agent profile');
        process.exit(1);
      }
    });
}
