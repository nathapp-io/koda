import { Command } from 'commander';
import { resolveContext } from '../config';
import { OpenAPI } from '../generated/core/OpenAPI';
import {
  codeIntelControllerGetSymbol,
  codeIntelControllerGetCallers,
  codeIntelControllerGetCallees,
} from '../generated';
import { table } from '../utils/output';
import { unwrap } from '../utils/api';
import { handleApiError } from '../utils/error';

export function codeIntelCommand(program: Command): void {
  const ci = program.command('code-intel');
  ci.description('Query code intelligence (symbols, callers, callees)');

  ci
    .command('symbol')
    .description('Get a symbol by ID')
    .requiredOption('--symbol-id <id>', 'Symbol ID ({repoId}:{file}::{Name})')
    .option('--project <slug>', 'Project slug')
    .option('--json', 'Output as JSON')
    .action(async (options) => {
      try {
        const ctx = await resolveContext({ projectSlug: options.project });
        if (!ctx.apiKey || !ctx.apiUrl) {
          handleApiError(new Error('API key or URL not configured. Run: koda login --api-key <key>'), { configError: true });
        }

        OpenAPI.BASE = ctx.apiUrl.replace(/\/api\/?$/, '');
        OpenAPI.TOKEN = ctx.apiKey;

        const response = await codeIntelControllerGetSymbol({
          symbolId: options.symbolId,
          projectSlug: ctx.projectSlug ?? options.project,
        });
        const data = unwrap<Record<string, unknown>>(response);

        if (options.json) {
          console.log(JSON.stringify(data, null, 2));
        } else {
          const rows = [
            ['ID', String(data['id'] ?? '')],
            ['Name', String(data['name'] ?? '')],
            ['Kind', String(data['kind'] ?? '')],
            ['File', String(data['file'] ?? '')],
            ['Lines', `${data['startLine']}–${data['endLine']}`],
            ['Signature', String(data['signature'] ?? '')],
          ];
          table(['Field', 'Value'], rows);
        }
        process.exit(0);
      } catch (err: unknown) {
        handleApiError(err, { notFoundMessage: `Symbol not found: ${options.symbolId}` });
      }
    });

  ci
    .command('callers')
    .description('List symbols that call a given symbol')
    .requiredOption('--symbol-id <id>', 'Symbol ID')
    .option('--project <slug>', 'Project slug')
    .option('--json', 'Output as JSON')
    .action(async (options) => {
      try {
        const ctx = await resolveContext({ projectSlug: options.project });
        if (!ctx.apiKey || !ctx.apiUrl) {
          handleApiError(new Error('API key or URL not configured. Run: koda login --api-key <key>'), { configError: true });
        }

        OpenAPI.BASE = ctx.apiUrl.replace(/\/api\/?$/, '');
        OpenAPI.TOKEN = ctx.apiKey;

        const response = await codeIntelControllerGetCallers({
          symbolId: options.symbolId,
          projectSlug: ctx.projectSlug ?? options.project,
        });
        const raw = unwrap<{ items?: Array<Record<string, unknown>> } | Array<Record<string, unknown>>>(response);
        const items: Array<Record<string, unknown>> = Array.isArray(raw)
          ? raw
          : ((raw as { items?: Array<Record<string, unknown>> }).items ?? []);

        if (options.json) {
          console.log(JSON.stringify(items, null, 2));
        } else {
          const rows = items.map((s) => [String(s['symbolId'] ?? s['id'] ?? ''), String(s['name'] ?? ''), String(s['file'] ?? '')]);
          table(['Symbol ID', 'Name', 'File'], rows);
        }
        process.exit(0);
      } catch (err: unknown) {
        handleApiError(err);
      }
    });

  ci
    .command('callees')
    .description('List symbols called by a given symbol')
    .requiredOption('--symbol-id <id>', 'Symbol ID')
    .option('--project <slug>', 'Project slug')
    .option('--json', 'Output as JSON')
    .action(async (options) => {
      try {
        const ctx = await resolveContext({ projectSlug: options.project });
        if (!ctx.apiKey || !ctx.apiUrl) {
          handleApiError(new Error('API key or URL not configured. Run: koda login --api-key <key>'), { configError: true });
        }

        OpenAPI.BASE = ctx.apiUrl.replace(/\/api\/?$/, '');
        OpenAPI.TOKEN = ctx.apiKey;

        const response = await codeIntelControllerGetCallees({
          symbolId: options.symbolId,
          projectSlug: ctx.projectSlug ?? options.project,
        });
        const raw = unwrap<{ items?: Array<Record<string, unknown>> } | Array<Record<string, unknown>>>(response);
        const items: Array<Record<string, unknown>> = Array.isArray(raw)
          ? raw
          : ((raw as { items?: Array<Record<string, unknown>> }).items ?? []);

        if (options.json) {
          console.log(JSON.stringify(items, null, 2));
        } else {
          const rows = items.map((s) => [String(s['symbolId'] ?? s['id'] ?? ''), String(s['name'] ?? ''), String(s['file'] ?? '')]);
          table(['Symbol ID', 'Name', 'File'], rows);
        }
        process.exit(0);
      } catch (err: unknown) {
        handleApiError(err);
      }
    });
}
