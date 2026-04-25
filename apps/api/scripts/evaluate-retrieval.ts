import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const CI_THRESHOLD = 0.70;

const appRoot = resolve(__dirname, '..');
const { AppFactory } = await import('@nathapp/nestjs-app');
const { AppModule } = await import(resolve(appRoot, 'dist/app.module.js'));
const { EvaluationService } = await import(resolve(appRoot, 'dist/retrieval/evaluation.service.js'));
const { HybridRetrieverService } = await import(resolve(appRoot, 'dist/rag/hybrid-retriever.service.js'));
const { loadEvalQueries } = await import(resolve(appRoot, 'dist/retrieval/load-queries.js'));

const app = await AppFactory.createFastifyApp(AppModule, { logger: false });
const evaluationService = app.get(EvaluationService);
const hybridRetriever = app.get(HybridRetrieverService);

const evalProjectId = process.env.RAG_EVAL_PROJECT_ID ?? 'proj_eval_001';

// ── One-time seed of evaluation documents ────────────────────────────────────
const evalDocuments = [
  { sourceId: 'doc-001', source: 'doc' as const, content: 'How to configure JWT token refresh. Configure the refresh token expiration in your IdP settings.' },
  { sourceId: 'doc-002', source: 'doc' as const, content: 'OAuth2 token expiration and refresh flow. Access tokens expire after 1 hour by default.' },
  { sourceId: 'doc-003', source: 'doc' as const, content: 'Null pointer exception in authentication service. NPE occurs when currentUser is null after JWT validation.' },
  { sourceId: 'doc-004', source: 'doc' as const, content: 'Database connection pool settings. Set max pool size to 2x CPU cores.' },
  { sourceId: 'doc-005', source: 'doc' as const, content: 'Load balancer health check endpoint. Configure /healthz to return 200.' },
  { sourceId: 'doc-006', source: 'doc' as const, content: 'Multi-region deployment setup. Deploy to 3 regions.' },
  { sourceId: 'doc-007', source: 'doc' as const, content: 'API rate limiting configuration. Apply token bucket algorithm.' },
  { sourceId: 'doc-008', source: 'doc' as const, content: 'Docker container restart policy.' },
  { sourceId: 'doc-009', source: 'doc' as const, content: 'File upload size limit exceeded. Default limit is 10MB.' },
  { sourceId: 'doc-010', source: 'doc' as const, content: 'Deployment rollback procedure.' },
  { sourceId: 'doc-011', source: 'doc' as const, content: 'GraphQL query depth limit. Implement max depth rule at schema level.' },
  { sourceId: 'doc-012', source: 'doc' as const, content: 'Currency conversion rates outdated.' },
  { sourceId: 'doc-013', source: 'doc' as const, content: 'Query parameter injection prevention. Use parameterized queries.' },
  { sourceId: 'doc-014', source: 'doc' as const, content: 'gRPC streaming backpressure.' },
  { sourceId: 'doc-015', source: 'doc' as const, content: 'Payment webhook retry logic.' },
  { sourceId: 'doc-016', source: 'doc' as const, content: 'Mobile app push notification token.' },
  { sourceId: 'doc-017', source: 'doc' as const, content: 'Timezone handling for scheduled tasks.' },
  { sourceId: 'doc-018', source: 'doc' as const, content: 'S3 bucket lifecycle policy.' },
  { sourceId: 'doc-019', source: 'doc' as const, content: 'Tracing span context propagation.' },
  { sourceId: 'doc-020', source: 'doc' as const, content: 'API versioning strategy.' },
  { sourceId: 'doc-021', source: 'doc' as const, content: 'Elasticsearch index mapping update.' },
  { sourceId: 'doc-022', source: 'doc' as const, content: 'Service mesh mTLS configuration.' },
  { sourceId: 'doc-023', source: 'doc' as const, content: 'Log aggregation query syntax.' },
  { sourceId: 'doc-024', source: 'doc' as const, content: 'Inbound webhook signature verification.' },
  { sourceId: 'doc-025', source: 'doc' as const, content: 'Message queue consumer group rebalance.' },
  { sourceId: 'doc-026', source: 'doc' as const, content: 'Secrets manager rotation policy.' },
  { sourceId: 'doc-027', source: 'doc' as const, content: 'Batch job retry exponential backoff.' },
  { sourceId: 'doc-028', source: 'doc' as const, content: 'Idempotency key deduplication window.' },
  { sourceId: 'manual-001', source: 'manual' as const, content: 'Docker container restart policy reference.' },
  { sourceId: 'manual-002', source: 'manual' as const, content: 'Database connection pool settings reference.' },
  { sourceId: 'manual-003', source: 'manual' as const, content: 'Load balancer health check configuration.' },
  { sourceId: 'manual-004', source: 'manual' as const, content: 'Deployment rollback procedure guide.' },
  { sourceId: 'manual-005', source: 'manual' as const, content: 'Multi-region deployment guide.' },
  { sourceId: 'manual-006', source: 'manual' as const, content: 'S3 bucket lifecycle policy configuration.' },
  { sourceId: 'manual-007', source: 'manual' as const, content: 'API versioning best practices.' },
  { sourceId: 'manual-008', source: 'manual' as const, content: 'Service mesh mTLS configuration guide.' },
  { sourceId: 'manual-009', source: 'manual' as const, content: 'Database migration rollback guide.' },
  { sourceId: 'manual-010', source: 'manual' as const, content: 'Secrets manager rotation guide.' },
  { sourceId: 'ticket-001', source: 'ticket' as const, content: 'Ticket #1: Null pointer exception in authentication service.' },
  { sourceId: 'ticket-002', source: 'ticket' as const, content: 'Ticket #2: Memory leak in background worker.' },
  { sourceId: 'ticket-003', source: 'ticket' as const, content: 'Ticket #3: Slow query performance on dashboard.' },
  { sourceId: 'ticket-004', source: 'ticket' as const, content: 'Ticket #4: Authentication fails with SSO provider.' },
  { sourceId: 'ticket-005', source: 'ticket' as const, content: 'Ticket #5: File upload size limit exceeded.' },
  { sourceId: 'ticket-006', source: 'ticket' as const, content: 'Ticket #6: WebSocket disconnection issues.' },
  { sourceId: 'ticket-007', source: 'ticket' as const, content: 'Ticket #7: Email notification not sent.' },
  { sourceId: 'ticket-008', source: 'ticket' as const, content: 'Ticket #8: Search index corruption after crash.' },
  { sourceId: 'ticket-009', source: 'ticket' as const, content: 'Ticket #9: Admin panel access denied for new users.' },
  { sourceId: 'ticket-010', source: 'ticket' as const, content: 'Ticket #10: Currency conversion rates outdated.' },
  { sourceId: 'ticket-011', source: 'ticket' as const, content: 'Ticket #11: Export CSV includes deleted records.' },
  { sourceId: 'ticket-012', source: 'ticket' as const, content: 'Ticket #12: Payment webhook retry logic.' },
  { sourceId: 'ticket-013', source: 'ticket' as const, content: 'Ticket #13: Dark mode toggle not persisting.' },
  { sourceId: 'ticket-014', source: 'ticket' as const, content: 'Ticket #14: Audit log missing entries.' },
  { sourceId: 'ticket-015', source: 'ticket' as const, content: 'Ticket #15: How to configure JWT token refresh.' },
  { sourceId: 'ticket-016', source: 'ticket' as const, content: 'Ticket #16: OAuth2 token expiration handling.' },
  { sourceId: 'ticket-017', source: 'ticket' as const, content: 'Ticket #17: GraphQL query depth limit.' },
  { sourceId: 'ticket-018', source: 'ticket' as const, content: 'Ticket #18: Redis cache invalidation timing.' },
  { sourceId: 'ticket-019', source: 'ticket' as const, content: 'Ticket #19: gRPC streaming backpressure.' },
  { sourceId: 'ticket-020', source: 'ticket' as const, content: 'Ticket #20: Session fixation vulnerability.' },
  { sourceId: 'ticket-021', source: 'ticket' as const, content: 'Ticket #21: Feature flag evaluation delay.' },
  { sourceId: 'ticket-022', source: 'ticket' as const, content: 'Ticket #22: User permissions cache stale.' },
  { sourceId: 'ticket-023', source: 'ticket' as const, content: 'Ticket #23: Query parameter injection prevention.' },
  { sourceId: 'ticket-024', source: 'ticket' as const, content: 'Ticket #24: Mobile app push notification token.' },
  { sourceId: 'ticket-025', source: 'ticket' as const, content: 'Ticket #25: CI pipeline cache miss every build.' },
  { sourceId: 'ticket-026', source: 'ticket' as const, content: 'Ticket #26: Timezone handling for scheduled tasks.' },
  { sourceId: 'ticket-027', source: 'ticket' as const, content: 'Ticket #27: Dark mode toggle not persisting.' },
  { sourceId: 'ticket-028', source: 'ticket' as const, content: 'Ticket #28: Memory leak in background worker.' },
  { sourceId: 'ticket-029', source: 'ticket' as const, content: 'Ticket #29: Authentication fails with SSO provider.' },
  { sourceId: 'ticket-030', source: 'ticket' as const, content: 'Ticket #30: Tracing span context propagation.' },
  { sourceId: 'ticket-031', source: 'ticket' as const, content: 'Ticket #31: Admin panel access denied for new users.' },
  { sourceId: 'ticket-032', source: 'ticket' as const, content: 'Ticket #32: Kanban board drag drop lag.' },
  { sourceId: 'ticket-033', source: 'ticket' as const, content: 'Ticket #33: API rate limiting configuration.' },
  { sourceId: 'ticket-034', source: 'ticket' as const, content: 'Ticket #34: User permissions cache stale.' },
  { sourceId: 'ticket-035', source: 'ticket' as const, content: 'Ticket #35: Database migration rollback.' },
  { sourceId: 'ticket-036', source: 'ticket' as const, content: 'Ticket #36: Message queue consumer group rebalance.' },
  { sourceId: 'ticket-037', source: 'ticket' as const, content: 'Ticket #37: Session fixation vulnerability.' },
  { sourceId: 'ticket-038', source: 'ticket' as const, content: 'Ticket #38: GraphQL subscription reconnect.' },
  { sourceId: 'ticket-039', source: 'ticket' as const, content: 'Ticket #39: Access token refresh race condition.' },
  { sourceId: 'ticket-040', source: 'ticket' as const, content: 'Ticket #40: Search index corruption after crash.' },
  { sourceId: 'ticket-041', source: 'ticket' as const, content: 'Ticket #41: Batch job retry exponential backoff.' },
  { sourceId: 'ticket-042', source: 'ticket' as const, content: 'Ticket #42: Idempotency key deduplication window.' },
  { sourceId: 'ticket-043', source: 'ticket' as const, content: 'Ticket #43: Redis cache invalidation timing.' },
  { sourceId: 'ticket-044', source: 'ticket' as const, content: 'Ticket #44: Memory leak in background worker.' },
];

let seeded = 0;
for (const doc of evalDocuments) {
  await hybridRetriever.indexDocument(evalProjectId, {
    source: doc.source,
    sourceId: doc.sourceId,
    content: doc.content,
    metadata: { type: 'eval' },
  });
  seeded++;
}
console.log(`  Seeded ${seeded} eval documents`);

// ── Run evaluation ────────────────────────────────────────────────────────────
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
