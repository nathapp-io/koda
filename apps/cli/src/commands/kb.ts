import { Command } from 'commander';
import { readFileSync } from 'fs';
import { basename } from 'path';
import { resolveAuth } from '../utils/auth';
import { configureClient } from '../client';
import { KbService } from '../generated';
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
      if (!options.project || !options.query) {
        error('Missing required option: --project and --query are required');
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

        const client = configureClient(auth.apiUrl, auth.apiKey);
        const response = await KbService.search(client, options.project, options.query);
        const data = unwrap(response);

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
      if (!options.project) {
        error('Missing required option: --project is required');
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

        const client = configureClient(auth.apiUrl, auth.apiKey);
        const response = await KbService.list(client, options.project);
        const data = unwrap(response);

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
    .option('--json', 'Output as JSON')
    .action(async (options) => {
      if (!options.project || !options.file) {
        error('Missing required option: --project and --file are required');
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

        const content = readFileSync(options.file, 'utf-8');
        const fileName = basename(options.file);

        const client = configureClient(auth.apiUrl, auth.apiKey);
        const response = await KbService.add(client, options.project, { content, source: fileName });
        const data = unwrap(response);

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
