import { Command } from 'commander';
import { ProjectsService } from '../generated';
import { configureClient } from '../client';
import { getConfig } from '../config';
import { output, table } from '../utils/output';

export function projectCommand(program: Command): void {
  program
    .command('project')
    .addCommand(
      new Command('list')
        .option('--json', 'Output as JSON')
        .action(async (options) => {
          const config = getConfig();

          // Check if API key is configured
          if (!config.apiKey) {
            console.error('Error: API key not configured. Run "koda login --api-key <key>" first.');
            process.exit(2);
          }

          const client = configureClient(config.apiUrl || 'http://localhost:3100/api', config.apiKey);

          try {
            const response = await ProjectsService.list(client);
            const projects = response.data || [];

            if (options.json) {
              output(projects, { json: true });
            } else {
              const headers = ['Name', 'Key', 'Slug'];
              const rows = projects.map((p: any) => [p.name, p.key, p.slug]);
              table(headers, rows);
            }
          } catch (err) {
            console.error('Failed to fetch projects:', err);
            process.exit(1);
          }
        })
    )
    .addCommand(
      new Command('show')
        .argument('<slug>', 'Project slug')
        .option('--json', 'Output as JSON')
        .action(async (slug: string, options: any) => {
          // Workaround: When this command is invoked via parseAsync with a full nested path
          // that includes the parent command name ('project'), Commander may incorrectly
          // parse 'project' as the slug argument instead of the actual slug
          let actualSlug = slug;

          // If slug is 'project', this is likely the workaround case
          // Look for the actual slug in process.argv
          if (slug === 'project' || !slug) {
            // Find the index of 'show' in process.argv
            const argv = process.argv;
            const showIndex = argv.indexOf('show');
            if (showIndex >= 0 && showIndex + 1 < argv.length) {
              const nextArg = argv[showIndex + 1];
              // If there's an argument after 'show' that's not an option, use it
              if (nextArg && !nextArg.startsWith('-')) {
                actualSlug = nextArg;
              } else if (slug === 'project') {
                // slug is 'project' but there's no real argument - this is an error
                throw new Error('Missing required argument: <slug>');
              }
            } else {
              // No argument found after 'show' - this is an error
              throw new Error('Missing required argument: <slug>');
            }
          }

          const config = getConfig();

          // Check if API key is configured
          if (!config.apiKey) {
            console.error('Error: API key not configured. Run "koda login --api-key <key>" first.');
            process.exit(2);
          }

          const client = configureClient(config.apiUrl || 'http://localhost:3100/api', config.apiKey);

          try {
            const response = await ProjectsService.show(client, { path: { slug: actualSlug } });
            const project = response.data;

            if (options.json) {
              output(project, { json: true });
            } else {
              const headers = ['Field', 'Value'];
              const rows = Object.entries(project).map(([key, value]) => [
                key,
                String(value),
              ]);
              table(headers, rows);
            }
          } catch (err) {
            console.error('Failed to fetch project:', err);
            process.exit(1);
          }
        })
    );
}
