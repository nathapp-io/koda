import { Command } from 'commander';
import { resolveContext } from '../config';
import { configureClient } from '../client';
import { LabelsService } from '../generated';
import { table } from '../utils/output';
import { unwrap } from '../utils/api';
import { handleApiError } from '../utils/error';

export function labelCommand(program: Command): void {
  const label = program.command('label');

  label.description('Manage labels');

  label
    .command('create')
    .description('Create a label in a project')
    .option('--project <slug>', 'Project slug')
    .requiredOption('--name <name>', 'Label name')
    .option('--color <hex>', 'Label color (hex, e.g. #ff0000)')
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
        const response = await LabelsService.create(client, {
          projectSlug: ctx.projectSlug,
          name: options.name,
          color: options.color,
        });
        const labelData = unwrap(response);

        if (options.json) {
          console.log(JSON.stringify(labelData, null, 2));
        } else {
          const rows = [
            ['ID', labelData.id],
            ['Name', labelData.name],
            ['Color', labelData.color ?? ''],
          ];
          table(['Field', 'Value'], rows);
        }

        process.exit(0);
      } catch (err: unknown) {
        handleApiError(err);
      }
    });

  label
    .command('list')
    .description('List labels in a project')
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
        const response = await LabelsService.list(client, ctx.projectSlug);
        const data = unwrap(response);
        const items: Record<string, unknown>[] = Array.isArray(data) ? data : ((data as Record<string, unknown>).items as Record<string, unknown>[]) || [];

        if (options.json) {
          console.log(JSON.stringify(items, null, 2));
        } else {
          const rows = items.map((l) => [String(l.id), String(l.name), String(l.color ?? '')]);
          table(['ID', 'Name', 'Color'], rows);
        }

        process.exit(0);
      } catch (err: unknown) {
        handleApiError(err);
      }
    });

  label
    .command('delete')
    .description('Delete a label from a project')
    .option('--project <slug>', 'Project slug')
    .requiredOption('--id <id>', 'Label ID')
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
        await LabelsService.delete(client, ctx.projectSlug, options.id);

        console.log(`Label '${options.id}' deleted.`);
        process.exit(0);
      } catch (err: unknown) {
        handleApiError(err, { notFoundMessage: `Label not found: ${options.id}` });
      }
    });
}