import { Command } from 'commander';
import { resolveAuth } from '../utils/auth';
import { configureClient } from '../client';
import { ProjectsService } from '../generated';
import { table, error } from '../utils/output';

export function projectCommand(program: Command): void {
  const project = program.command('project');

  project
    .command('list')
    .option('--json', 'Output as JSON')
    .action(async (options) => {
      try {
        const auth = resolveAuth({});

        if (!auth.apiKey || !auth.apiUrl) {
          error('API key or URL not configured. Run: koda login --api-key <key>');
          process.exit(2);
        }

        const client = configureClient(auth.apiUrl, auth.apiKey);
        const response = await ProjectsService.list(client);

        if (options.json) {
          console.log(JSON.stringify(response.data, null, 2));
        } else {
          const rows = response.data.map((p) => [p.name, p.key, p.slug]);
          table(['Name', 'Key', 'Slug'], rows);
        }

        process.exit(0);
      } catch (err: unknown) {
        const apiError = err as { response?: { status?: number }; message?: string };
        const statusCode = apiError.response?.status;
        if (statusCode === 401 || statusCode === 403) {
          error('Unauthorized. Please check your API key.');
          process.exit(2);
        }
        error(apiError.message || 'Failed to fetch projects');
        process.exit(1);
      }
    });

  project
    .command('show <slug>')
    .option('--json', 'Output as JSON')
    .action(async (slug: string, options) => {
      try {
        const auth = resolveAuth({});

        if (!auth.apiKey || !auth.apiUrl) {
          error('API key or URL not configured. Run: koda login --api-key <key>');
          process.exit(2);
        }

        const client = configureClient(auth.apiUrl, auth.apiKey);
        const response = await ProjectsService.show(client, slug);

        if (options.json) {
          console.log(JSON.stringify(response.data, null, 2));
        } else {
          const rows = [[response.data.name, response.data.key, response.data.slug]];
          table(['Name', 'Key', 'Slug'], rows);
        }

        process.exit(0);
      } catch (err: unknown) {
        const apiError = err as { response?: { status?: number }; message?: string };
        const statusCode = apiError.response?.status;
        if (statusCode === 401 || statusCode === 403) {
          error('Unauthorized. Please check your API key.');
          process.exit(2);
        }
        if (statusCode === 404) {
          error(`Project not found: ${slug}`);
          process.exit(1);
        }
        error(apiError.message || 'Failed to fetch project');
        process.exit(1);
      }
    });
}
