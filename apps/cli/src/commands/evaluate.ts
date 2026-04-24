import { Command } from 'commander';
import { resolveContext } from '../config';
import { handleApiError } from '../utils/error';
import { OpenAPI } from '../generated';

const CI_THRESHOLD = 0.70;

// ragControllerEvaluateRetrieval will be generated after API contract change
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let ragControllerEvaluateRetrieval: any;
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const generated = require('../generated');
  ragControllerEvaluateRetrieval = generated.ragControllerEvaluateRetrieval;
} catch {
  ragControllerEvaluateRetrieval = undefined;
}

export function evaluateCommand(program: Command): void {
  const evaluate = new Command('evaluate');
  evaluate
    .description('Run retrieval evaluation harness')
    .option('--json', 'Output raw JSON summary')
    .action(async () => {
      const opts = evaluate.optsWithGlobals();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const ctx = await resolveContext(opts as any);

      if (!ctx.apiKey) {
        console.error('Error: API key is required');
        process.exit(2);
      }
      if (!ctx.apiUrl) {
        console.error('Error: API URL is required');
        process.exit(2);
      }

      OpenAPI.BASE = ctx.apiUrl;
      OpenAPI.TOKEN = ctx.apiKey;

      try {
        const result = await ragControllerEvaluateRetrieval({
          projectSlug: ctx.projectSlug!,
        });

        const summary = result.data;

        if (opts.json) {
          console.log(JSON.stringify(summary, null, 2));
          process.exit(0);
        }

        console.log('\n=== Retrieval Evaluation Results ===\n');
        console.log(
          `  precision@5_avg : ${summary.precisionAt5_avg.toFixed(3)}`
        );
        console.log(
          `  precision@5_p50 : ${summary.precisionAt5_p50.toFixed(3)}`
        );
        console.log(
          `  precision@5_p95 : ${summary.precisionAt5_p95.toFixed(3)}`
        );
        console.log(`  total_queries  : ${summary.totalQueries}`);
        console.log('');

        if (summary.results.length > 0) {
          console.log('Per-query results:');
          for (const r of summary.results) {
            console.log(
              `  [${r.precisionAt5.toFixed(2)}] "${r.query}" (intent=${r.intent})`
            );
          }
          console.log('');
        }

        if (summary.precisionAt5_avg < CI_THRESHOLD) {
          console.error(
            `ERROR: precision@5_avg=${summary.precisionAt5_avg.toFixed(3)} is below CI threshold ${CI_THRESHOLD}`
          );
          process.exit(1);
        }

        process.exit(0);
      } catch (err) {
        handleApiError(err);
      }
    });

  program.addCommand(evaluate);
}
