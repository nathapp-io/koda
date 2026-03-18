import { Command } from 'commander';
import { getConfig } from '../config';
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
        const config = getConfig();

        if (!config.apiKey || !config.apiUrl) {
          error('API key or URL not configured. Run: koda login --api-key <key>');
          process.exit(2);
        }

        const client = configureClient(config.apiUrl, config.apiKey);
        const response = await ProjectsService.list(client);

        if (options.json) {
          console.log(JSON.stringify(response.data, null, 2));
        } else {
          const rows = response.data.map((p) => [p.name, p.key, p.slug]);
          table(['Name', 'Key', 'Slug'], rows);
        }

        process.exit(0);
      } catch (err: any) {
        const statusCode = err.response?.status;
        if (statusCode === 401 || statusCode === 403) {
          error('Unauthorized. Please check your API key.');
          process.exit(2);
        }
        error(err.message || 'Failed to fetch projects');
        process.exit(1);
      }
    });

  project
    .command('show <slug>')
    .option('--json', 'Output as JSON')
    .action(async (slug: string, options) => {
      try {
        const config = getConfig();

        if (!config.apiKey || !config.apiUrl) {
          error('API key or URL not configured. Run: koda login --api-key <key>');
          process.exit(2);
        }

        const client = configureClient(config.apiUrl, config.apiKey);
        const response = await ProjectsService.show(client, slug);

        if (options.json) {
          console.log(JSON.stringify(response.data, null, 2));
        } else {
          console.log(`Project: ${response.data.name}`);
          console.log(`Key: ${response.data.key}`);
          console.log(`Slug: ${response.data.slug}`);
          if (response.data.description) {
            console.log(`Description: ${response.data.description}`);
          }
        }

        process.exit(0);
      } catch (err: any) {
        const statusCode = err.response?.status;
        if (statusCode === 401 || statusCode === 403) {
          error('Unauthorized. Please check your API key.');
          process.exit(2);
        }
        if (statusCode === 404) {
          error(`Project not found: ${slug}`);
          process.exit(1);
        }
        error(err.message || 'Failed to fetch project');
        process.exit(1);
      }
    });
}
