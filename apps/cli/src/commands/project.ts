import { Command } from 'commander';
import { resolveAuth } from '../utils/auth';
import { configureClient } from '../client';
import { ProjectsService } from '../generated';
import { table, error } from '../utils/output';
import { unwrap } from '../utils/api';
import { handleApiError } from '../utils/error';

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
        const { items } = unwrap(response);

        if (options.json) {
          console.log(JSON.stringify(items, null, 2));
        } else {
          const rows = items.map((p) => [p.name, p.key, p.slug]);
          table(['Name', 'Key', 'Slug'], rows);
        }

        process.exit(0);
      } catch (err: unknown) {
        handleApiError(err);
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
        const project = unwrap(response);

        if (options.json) {
          console.log(JSON.stringify(project, null, 2));
        } else {
          const rows = [[project.name, project.key, project.slug]];
          table(['Name', 'Key', 'Slug'], rows);
        }

        process.exit(0);
      } catch (err: unknown) {
        handleApiError(err, { notFoundMessage: `Project not found: ${slug}` });
      }
    });
}
