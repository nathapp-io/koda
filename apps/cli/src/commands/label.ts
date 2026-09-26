import { Command } from 'commander';
import {
  labelsControllerCreateFromHttp,
  labelsControllerFindByProjectFromHttp,
  labelsControllerDeleteFromHttp,
  labelsControllerUpdateFromHttp,
} from '../generated';
import { table } from '../utils/output';
import { unwrap } from '../utils/api';
import { handleApiError } from '../utils/error';
import { withContext } from '../utils/context';

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
        const ctx = await withContext({ projectSlug: options.project });

        const response = await labelsControllerCreateFromHttp({
  body: { name: options.name, color: options.color },
  path: { slug: ctx.projectSlug }
  });
        const labelData = unwrap<{ id: string; name: string; color?: string }>(response);

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
        const ctx = await withContext({ projectSlug: options.project });

        const response = await labelsControllerFindByProjectFromHttp({ path: { slug: ctx.projectSlug }});
        const data = unwrap<{ items?: Array<Record<string, unknown>> } | Array<Record<string, unknown>>>(response);
        const items: Array<Record<string, unknown>> = Array.isArray(data)
          ? data
          : ((data as { items?: Array<Record<string, unknown>> }).items ?? []);

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
        const ctx = await withContext({ projectSlug: options.project });

        await labelsControllerDeleteFromHttp({ path: { slug: ctx.projectSlug, id: options.id }});

        console.log(`Label '${options.id}' deleted.`);
        process.exit(0);
      } catch (err: unknown) {
        handleApiError(err, { notFoundMessage: `Label not found: ${options.id}` });
      }
    });

  label
    .command('update')
    .description('Update a label in a project')
    .option('--project <slug>', 'Project slug')
    .requiredOption('--id <id>', 'Label ID')
    .option('--name <name>', 'Label name')
    .option('--color <hex>', 'Label color (hex, e.g. #ff0000)')
    .option('--json', 'Output as JSON')
    .action(async (options) => {
      if (!options.name && !options.color) {
        handleApiError(new Error('Must provide at least one option: --name or --color'), { validationError: true });
      }

      try {
        const ctx = await withContext({ projectSlug: options.project });

        const requestBody: { name?: string; color?: string } = {};
        if (options.name) requestBody.name = options.name;
        if (options.color) requestBody.color = options.color;

        const response = await labelsControllerUpdateFromHttp({
  body: requestBody,
  path: { slug: ctx.projectSlug, id: options.id }
  });
        const labelData = unwrap<{ id: string; name: string; color?: string }>(response);

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
        handleApiError(err, { notFoundMessage: `Label not found: ${options.id}` });
      }
    });
}
