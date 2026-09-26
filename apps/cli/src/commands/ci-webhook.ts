import { Command } from 'commander';
import { ciWebhookControllerHandleCiWebhook } from '../generated';
import { unwrap } from '../utils/api';
import { handleApiError } from '../utils/error';
import { withContext } from '../utils/context';

export function ciWebhookCommand(program: Command): void {
  const ciWebhook = program.command('ci-webhook');
  ciWebhook.description('Inbound CI event integration');

  ciWebhook
    .command('trigger')
    .description('Send a CI event payload to the Koda CI webhook endpoint')
    .option('--project <slug>', 'Project slug')
    .requiredOption('--event <type>', 'CI event type: pipeline_failed | pipeline_success')
    .requiredOption('--pipeline-id <id>', 'Pipeline identifier')
    .option('--pipeline-url <url>', 'URL of the pipeline run')
    .requiredOption('--commit-sha <sha>', 'Commit SHA')
    .option('--commit-message <msg>', 'Commit message')
    .option('--failures <json>', 'JSON array of failure objects [{test, file?, line?}] (optional)')
    .option('--signature <sig>', 'CI webhook signature header value')
    .option('--json', 'Output as JSON')
    .action(async (options) => {
      try {
        const ctx = await withContext({ projectSlug: options.project });

        let failures: Array<{ test: string; file?: string; line?: number }> = [];
        if (options.failures) {
          try {
            failures = JSON.parse(options.failures as string) as Array<{ test: string; file?: string; line?: number }>;
          } catch {
            handleApiError(new Error('--failures must be valid JSON array of {test, file?, line?}'), { configError: true });
          }
        }

        const response = await ciWebhookControllerHandleCiWebhook({
          path: { slug: ctx.projectSlug },
          headers: {
            'x-ci-signature': options.signature,
            // SEC-1: the API requires a unique delivery id and a fresh Date header
            // to reject replayed deliveries.
            'x-ci-delivery': `cli-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
            date: new Date().toUTCString(),
          },
          body: {
            event: options.event as 'pipeline_failed' | 'pipeline_success',
            pipeline: { id: options.pipelineId, url: options.pipelineUrl },
            commit: { sha: options.commitSha, message: options.commitMessage },
            failures,
          },
        });
        const data = unwrap<Record<string, unknown>>(response);

        if (options.json) {
          console.log(JSON.stringify(data, null, 2));
        } else {
          console.log(`CI event '${options.event}' delivered successfully.`);
        }
        process.exit(0);
      } catch (err: unknown) {
        handleApiError(err);
      }
    });
}
