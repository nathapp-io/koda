/**
 * Retrieval Evaluation Harness
 *
 * Usage: bun run evaluate:retrieval (from apps/api directory)
 *
 * Loads the seed dataset (50 evaluation queries) and runs them through
 * the EvaluationService. Prints a CI-friendly table to stdout and exits
 * with code 1 if precision@5_avg < 0.70 (CI threshold).
 */

import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module';
import { EvaluationService } from '../src/retrieval/evaluation.service';
import { loadEvalQueries } from '../src/retrieval/load-queries';

const CI_THRESHOLD = 0.70;

async function main() {
  const app = await NestFactory.create(AppModule, { logger: false });

  const evaluationService = app.get(EvaluationService);
  const queries = loadEvalQueries();

  console.log(`\n=== Retrieval Evaluation (${queries.length} queries) ===\n`);

  const summary = await evaluationService.runQueries(queries);

  console.log(`  precision@5_avg : ${summary.precisionAt5_avg.toFixed(3)}`);
  console.log(`  precision@5_p50 : ${summary.precisionAt5_p50.toFixed(3)}`);
  console.log(`  precision@5_p95 : ${summary.precisionAt5_p95.toFixed(3)}`);
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
    await app.close();
    process.exit(1);
  }

  console.log(`PASS: precision@5_avg=${summary.precisionAt5_avg.toFixed(3)} >= ${CI_THRESHOLD}`);
  await app.close();
  process.exit(0);
}

main().catch((err) => {
  console.error('Evaluation failed:', err);
  process.exit(1);
});
