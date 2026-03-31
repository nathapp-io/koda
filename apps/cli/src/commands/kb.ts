import { Command } from 'commander';
import { readFileSync } from 'fs';
import { basename } from 'path';
import { resolveContext } from '../config';
import { OpenAPI } from '../generated/core/OpenAPI';
import { ragControllerSearch, ragControllerListDocuments, ragControllerAddDocument } from '../generated';
import { error } from '../utils/output';
import { unwrap } from '../utils/api';
import { handleApiError } from '../utils/error';

function scoreLabel(score: number): string {
  if (score >= 0.8) return 'HIGH';
  if (score >= 0.5) return 'MED';
  return 'LOW';
}

export function kbCommand(program: Command): void {
  const kb = program.command('kb').description('Knowledge base commands');

  kb
    .command('search')
    .description('Search the knowledge base')
    .option('--project <slug>', 'Project slug')
    .option('--query <text>', 'Search query')
    .option('--json', 'Output as JSON')
    .action(async (options) => {
      if (!options.query) {
        error('Missing required option: --query is required');
        process.exit(3);
        return;
      }

      try {
        const ctx = await resolveContext({ projectSlug: options.project });

        if (!ctx.projectSlug) {
          error('Project not configured. Run: koda init');
          process.exit(2);
          return;
        }

        if (!ctx.apiKey) {
          error('API key or URL not configured. Run: koda login --api-key <key>');
          process.exit(2);
          return;
        }

        OpenAPI.BASE = ctx.apiUrl.replace(/\/api\/?$/, '');
        OpenAPI.TOKEN = ctx.apiKey;

        const response = await ragControllerSearch({
          slug: ctx.projectSlug,
          requestBody: { query: options.query },
        });
        const data = unwrap<{
          verdict: string;
          confidence: number;
          results: Array<{ score: number; ticketRef: string; type: string; status: string; labels?: string[] }>;
        }>(response);

        if (options.json) {
          console.log(JSON.stringify(data, null, 2));
        } else {
          console.log(`Verdict: ${data.verdict}  Confidence: ${data.confidence}`);
          console.log('');
          for (const result of data.results) {
            const label = scoreLabel(result.score);
            const labels = result.labels?.length ? `  [${result.labels.join(', ')}]` : '';
            console.log(
              `${label}  score=${result.score}  ${result.ticketRef}  ${result.type}  ${result.status}${labels}`
            );
          }
        }

        process.exit(0);
      } catch (err: unknown) {
        handleApiError(err);
      }
    });

  kb
    .command('list')
    .description('List knowledge base documents')
    .option('--project <slug>', 'Project slug')
    .option('--json', 'Output as JSON')
    .action(async (options) => {
      try {
        const ctx = await resolveContext({ projectSlug: options.project });

        if (!ctx.projectSlug) {
          error('Project not configured. Run: koda init');
          process.exit(2);
          return;
        }

        if (!ctx.apiKey) {
          error('API key or URL not configured. Run: koda login --api-key <key>');
          process.exit(2);
          return;
        }

        OpenAPI.BASE = ctx.apiUrl.replace(/\/api\/?$/, '');
        OpenAPI.TOKEN = ctx.apiKey;

        const response = await ragControllerListDocuments({ slug: ctx.projectSlug, limit: '100' });
        const data = unwrap<{ items: Array<{ id: string; source: string; createdAt: string }>; total: number }>(response);

        if (options.json) {
          console.log(JSON.stringify(data, null, 2));
        } else {
          console.log('ID          Source              Created');
          console.log('----------- ------------------- -----------------------');
          for (const doc of data.items) {
            const created = new Date(doc.createdAt).toISOString().slice(0, 10);
            console.log(`${doc.id.padEnd(11)} ${doc.source.padEnd(19)} ${created}`);
          }
          console.log(`\nTotal: ${data.total}`);
        }

        process.exit(0);
      } catch (err: unknown) {
        handleApiError(err);
      }
    });

  kb
    .command('add')
    .description('Add a document to the knowledge base')
    .option('--project <slug>', 'Project slug')
    .option('--file <path>', 'Path to file to add')
    .option('--source <type>', 'Source type (ticket|doc|manual)', 'doc')
    .option('--json', 'Output as JSON')
    .action(async (options) => {
      if (!options.file) {
        error('Missing required option: --file is required');
        process.exit(3);
        return;
      }

      const validSources = ['ticket', 'doc', 'manual'];
      if (!validSources.includes(options.source)) {
        error(`Invalid source type: ${options.source}. Must be one of: ${validSources.join(', ')}`);
        process.exit(3);
        return;
      }

      try {
        const ctx = await resolveContext({ projectSlug: options.project });

        if (!ctx.projectSlug) {
          error('Project not configured. Run: koda init');
          process.exit(2);
          return;
        }

        if (!ctx.apiKey) {
          error('API key or URL not configured. Run: koda login --api-key <key>');
          process.exit(2);
          return;
        }

        const content = readFileSync(options.file, 'utf-8');
        const fileName = basename(options.file);

        OpenAPI.BASE = ctx.apiUrl.replace(/\/api\/?$/, '');
        OpenAPI.TOKEN = ctx.apiKey;

        const response = await ragControllerAddDocument({
          slug: ctx.projectSlug,
          requestBody: { content, source: options.source, sourceId: fileName },
        });
        const data = unwrap<{ id: string; source: string; docCount: number }>(response);

        if (options.json) {
          console.log(JSON.stringify(data, null, 2));
        } else {
          console.log(`Added ${fileName} to knowledge base. Total documents: ${data.docCount}`);
        }

        process.exit(0);
      } catch (err: unknown) {
        handleApiError(err);
      }
    });
}
