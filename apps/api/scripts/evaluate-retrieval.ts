import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const CI_THRESHOLD = 0.70;

const appRoot = resolve(__dirname, '..');
const { AppFactory } = await import('@nathapp/nestjs-app');
const { AppModule } = await import(resolve(appRoot, 'dist/main.js'));
const { EvaluationService } = await import(resolve(appRoot, 'dist/retrieval/evaluation.service.js'));
const { loadEvalQueries } = await import(resolve(appRoot, 'dist/retrieval/load-queries.js'));

const app = await AppFactory.createFastifyApp(AppModule, { logger: false });
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