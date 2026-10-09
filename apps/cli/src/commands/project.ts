import { Command } from 'commander';
import { resolveAuth } from '../utils/auth';
import {
  projectsControllerFindAll,
  projectsControllerFindBySlug,
  projectsControllerCreate,
  projectsControllerRemove,
  projectsControllerUpdate,
  projectsControllerGetProjectAgents,
  projectsControllerAddProjectAgent,
  projectsControllerRemoveProjectAgent,
  type ProjectAgentDto,
} from '../generated';
import { configureApiClient } from '../utils/api-client';
import { table, error } from '../utils/output';
import { unwrap } from '../utils/api';
import { handleApiError } from '../utils/error';
import { requireForce } from '../utils/force';
import { withContext } from '../utils/context';

export function projectCommand(program: Command): void {
  const project = program.command('project');

  project
    .command('agents')
    .description('List agents rostered to a project')
    .option('--project <slug>', 'Project slug')
    .option('--json', 'Output as JSON')
    .action(async (options) => {
      try {
        const ctx = await withContext({ projectSlug: options.project });
        const response = await projectsControllerGetProjectAgents({ path: { slug: ctx.projectSlug } });
        const roster = unwrap<{ scoping: boolean; items: Array<{ slug: string; name: string; status: string; openTicketCount: number }> }>(response);
        if (options.json) console.log(JSON.stringify(roster, null, 2));
        else {
          table(['Slug', 'Name', 'Status', 'Open tickets'], roster.items.map((item) => [
            item.slug, item.name, item.status, String(item.openTicketCount),
          ]));
        }
        if (!roster.scoping) error('Agent scoping is off on this server');
        process.exit(0);
      } catch (err: unknown) {
        handleApiError(err);
      }
    });

  project
    .command('agent-add <agentSlug>')
    .description('Add an agent to a project roster')
    .option('--project <slug>', 'Project slug')
    .option('--json', 'Output as JSON')
    .action(async (agentSlug: string, options) => {
      try {
        const ctx = await withContext({ projectSlug: options.project });
        const response = await projectsControllerAddProjectAgent({
          path: { slug: ctx.projectSlug },
          body: { agentSlug },
        });
        const added = unwrap<ProjectAgentDto>(response);
        if (options.json) console.log(JSON.stringify(added, null, 2));
        else console.log(`Added ${added.slug} to ${ctx.projectSlug}`);
        process.exit(0);
      } catch (err: unknown) {
        handleApiError(err);
      }
    });

  project
    .command('agent-remove <agentSlug>')
    .description('Remove an agent from a project roster')
    .option('--project <slug>', 'Project slug')
    .option('--json', 'Output as JSON')
    .action(async (agentSlug: string, options) => {
      try {
        const ctx = await withContext({ projectSlug: options.project });
        await projectsControllerRemoveProjectAgent({ path: { slug: ctx.projectSlug, agentSlug } });
        if (options.json) console.log(JSON.stringify({ removed: agentSlug }, null, 2));
        else console.log(`Removed ${agentSlug} from ${ctx.projectSlug}`);
        process.exit(0);
      } catch (err: unknown) {
        handleApiError(err);
      }
    });

  project
    .command('list')
    .option('--json', 'Output as JSON')
    .action(async (options) => {
      try {
        const auth = await resolveAuth({});

        if (!auth.apiKey || !auth.apiUrl) {
          error('API key or URL not configured. Run: koda login --api-key -');
          process.exit(2);
          return;
        }

        configureApiClient(auth.apiUrl.replace(/\/api\/?$/, ''), auth.apiKey);

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
        const auth = await resolveAuth({});

        if (!auth.apiKey || !auth.apiUrl) {
          error('API key or URL not configured. Run: koda login --api-key -');
          process.exit(2);
          return;
        }

        configureApiClient(auth.apiUrl.replace(/\/api\/?$/, ''), auth.apiKey);

        const response = await projectsControllerFindBySlug({ path: { slug }});
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
        const auth = await resolveAuth({});

        if (!auth.apiKey || !auth.apiUrl) {
          error('API key or URL not configured. Run: koda login --api-key -');
          process.exit(2);
          return;
        }

        configureApiClient(auth.apiUrl.replace(/\/api\/?$/, ''), auth.apiKey);

        const response = await projectsControllerCreate({
  body: {
            name: options.name,
            slug: options.slug,
            key: options.key,
            description: options.desc,
          }
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
      if (!requireForce(options.force)) return;

      try {
        const auth = await resolveAuth({});

        if (!auth.apiKey || !auth.apiUrl) {
          error('API key or URL not configured. Run: koda login --api-key -');
          process.exit(2);
          return;
        }

        configureApiClient(auth.apiUrl.replace(/\/api\/?$/, ''), auth.apiKey);

        await projectsControllerRemove({ path: { slug }});

        console.log(`Project '${slug}' deleted.`);
        process.exit(0);
      } catch (err: unknown) {
        handleApiError(err, { notFoundMessage: `Project not found: ${slug}` });
      }
    });

  project
    .command('update <slug>')
    .description('Update a project')
    .option('--name <name>', 'Project name')
    .option('--key <key>', 'Project key (2-6 uppercase letters)')
    .option('--desc <description>', 'Project description')
    .option('--json', 'Output as JSON')
    .action(async (slug: string, options) => {
      if (!options.name && !options.key && !options.desc) {
        handleApiError(new Error('Must provide at least one option: --name, --key, or --desc'), { validationError: true });
      }

      if (options.key && !/^[A-Z]{2,6}$/.test(options.key)) {
        error('Invalid key format. Must be 2-6 uppercase letters (e.g. KODA)');
        process.exit(3);
        return;
      }

      try {
        const auth = await resolveAuth({});

        if (!auth.apiKey || !auth.apiUrl) {
          error('API key or URL not configured. Run: koda login --api-key -');
          process.exit(2);
          return;
        }

        configureApiClient(auth.apiUrl.replace(/\/api\/?$/, ''), auth.apiKey);

        const requestBody: { name?: string; key?: string; description?: string } = {};
        if (options.name) requestBody.name = options.name;
        if (options.key) requestBody.key = options.key;
        if (options.desc) requestBody.description = options.desc;

        const response = await projectsControllerUpdate({ body: requestBody, path: { slug }});
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
}
