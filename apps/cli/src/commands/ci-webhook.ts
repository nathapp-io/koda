import { finishSuccess } from '../utils/output';
import { createHmac } from 'node:crypto';
import { Command } from 'commander';
import { ciWebhookControllerHandleCiWebhook } from '../generated';
import { unwrap } from '../utils/api';
import { handleApiError } from '../utils/error';
import { withContext } from '../utils/context';

/** The events the API's CI webhook accepts (`apps/api/src/ci-webhook/ci-webhook.dto.ts`). */
type CiEvent = 'pipeline_failed' | 'pipeline_success' | 'pipeline_succeeded';

export function ciWebhookCommand(program: Command): void {
  const ciWebhook = program.command('ci-webhook');
  ciWebhook.description('Inbound CI event integration');

  ciWebhook
    .command('trigger')
    .description('Send a CI event payload to the Koda CI webhook endpoint; set KODA_CI_WEBHOOK_SECRET to sign with v2')
    .option('--project <slug>', 'Project slug')
    .requiredOption('--event <type>', 'CI event type: pipeline_failed | pipeline_success | pipeline_succeeded')
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

        const body = {
          event: options.event as CiEvent,
          pipeline: { id: options.pipelineId, url: options.pipelineUrl },
          commit: { sha: options.commitSha, message: options.commitMessage },
          failures,
        };
        // SEC-1: the API requires a unique delivery id and a fresh Date header
        // to reject replayed deliveries.
        const delivery = `cli-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
        const secret = process.env.KODA_CI_WEBHOOK_SECRET;
        const signing = secret ? {
          secret,
          timestamp: String(Math.floor(Date.now() / 1000)),
          serialized: JSON.stringify(body),
        } : undefined;
        const signatureV2 = signing && `sha256=${createHmac('sha256', signing.secret)
          .update(`${signing.timestamp}.${delivery}.${signing.serialized}`)
          .digest('hex')}`;

        const response = await ciWebhookControllerHandleCiWebhook({
          path: { slug: ctx.projectSlug },
          headers: {
            'x-ci-signature': options.signature,
            'x-ci-delivery': delivery,
            date: new Date().toUTCString(),
            ...(signing && {
              'x-ci-timestamp': signing.timestamp,
              'x-ci-signature-v2': signatureV2,
            }),
          },
          body,
          ...(signing && { bodySerializer: () => signing.serialized }),
        });
        const data = unwrap<Record<string, unknown>>(response);

        if (options.json) {
          console.log(JSON.stringify(data, null, 2));
        } else {
          console.log(`CI event '${options.event}' delivered successfully.`);
        }
        return finishSuccess();
      } catch (err: unknown) {
        handleApiError(err, { hint: 'Check the value of KODA_CI_WEBHOOK_SECRET or --signature.' });
      }
    });
}
