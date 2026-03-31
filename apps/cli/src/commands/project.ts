import { Command } from 'commander';
import { resolveAuth } from '../utils/auth';
import { OpenAPI } from '../generated/core/OpenAPI';
import {
  projectsControllerFindAll,
  projectsControllerFindBySlug,
  projectsControllerCreate,
  projectsControllerRemove,
} from '../generated';
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
          return;
        }

        OpenAPI.BASE = auth.apiUrl.replace(/\/api\/?$/, '');
        OpenAPI.TOKEN = auth.apiKey;

        const response = await projectsControllerFindAll();
        const data = unwrap<{ items?: Array<Record<string, unknown>> } | Array<Record<string, unknown>>>(response);
        const items: Array<Record<string, unknown>> = Array.isArray(data)
          ? data
          : ((data as { items?: Array<Record<string, unknown>> }).items ?? []);

        if (options.json) {
          console.log(JSON.stringify(items, null, 2));
        } else {
          const rows = items.map((p) => [String(p.name), String(p.key), String(p.slug)]);
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
          return;
        }

        OpenAPI.BASE = auth.apiUrl.replace(/\/api\/?$/, '');
        OpenAPI.TOKEN = auth.apiKey;

        const response = await projectsControllerFindBySlug({ slug });
        const proj = unwrap<{ name: string; key: string; slug: string; description?: string }>(response);

        if (options.json) {
          console.log(JSON.stringify(proj, null, 2));
        } else {
          const rows = [
            ['Name', proj.name],
            ['Key', proj.key],
            ['Slug', proj.slug],
            ['Description', proj.description ?? ''],
          ];
          table(['Field', 'Value'], rows);
        }

        process.exit(0);
      } catch (err: unknown) {
        handleApiError(err, { notFoundMessage: `Project not found: ${slug}` });
      }
    });

  project
    .command('create')
    .requiredOption('--name <name>', 'Project name')
    .requiredOption('--slug <slug>', 'Project slug (lowercase alphanumeric + hyphens)')
    .requiredOption('--key <key>', 'Project key (2-6 uppercase letters)')
    .option('--desc <description>', 'Project description')
    .option('--json', 'Output as JSON')
    .action(async (options) => {
      if (!/^[A-Z]{2,6}$/.test(options.key)) {
        error('Invalid key format. Must be 2-6 uppercase letters (e.g. KODA)');
        process.exit(3);
        return;
      }

      if (!/^[a-z0-9-]+$/.test(options.slug)) {
        error('Invalid slug format. Must be lowercase alphanumeric and hyphens only');
        process.exit(3);
        return;
      }

      try {
        const auth = resolveAuth({});

        if (!auth.apiKey || !auth.apiUrl) {
          error('API key or URL not configured. Run: koda login --api-key <key>');
          process.exit(2);
          return;
        }

        OpenAPI.BASE = auth.apiUrl.replace(/\/api\/?$/, '');
        OpenAPI.TOKEN = auth.apiKey;

        const response = await projectsControllerCreate({
          requestBody: {
            name: options.name,
            slug: options.slug,
            key: options.key,
            description: options.desc,
          },
        });
        const proj = unwrap<{ name: string; key: string; slug: string; description?: string }>(response);

        if (options.json) {
          console.log(JSON.stringify(proj, null, 2));
        } else {
          const rows = [
            ['Name', proj.name],
            ['Key', proj.key],
            ['Slug', proj.slug],
            ['Description', proj.description ?? ''],
          ];
          table(['Field', 'Value'], rows);
        }

        process.exit(0);
      } catch (err: unknown) {
        handleApiError(err);
      }
    });

  project
    .command('delete <slug>')
    .option('--force', 'Confirm deletion')
    .action(async (slug: string, options) => {
      if (!options.force) {
        error('Use --force to confirm deletion');
        process.exit(1);
      }

      try {
        const auth = resolveAuth({});

        if (!auth.apiKey || !auth.apiUrl) {
          error('API key or URL not configured. Run: koda login --api-key <key>');
          process.exit(2);
          return;
        }

        OpenAPI.BASE = auth.apiUrl.replace(/\/api\/?$/, '');
        OpenAPI.TOKEN = auth.apiKey;

        await projectsControllerRemove({ slug });

        console.log(`Project '${slug}' deleted.`);
        process.exit(0);
      } catch (err: unknown) {
        handleApiError(err, { notFoundMessage: `Project not found: ${slug}` });
      }
    });
}
