/**
 * Seeds evaluation documents into the retrieval evaluation project.
 * Must run AFTER seed:prod (which creates proj_eval_001).
 *
 * Usage:
 *   bun run seed:prod && bun run seed:eval:documents
 *   RAG_EVAL_PROJECT_ID=proj_eval_001 bun run seed:eval:documents
 */
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const appRoot = resolve(__dirname, '..');
const { AppFactory } = await import('@nathapp/nestjs-app');
const { AppModule } = await import(resolve(appRoot, 'dist/main.js'));
const { HybridRetrieverService } = await import(resolve(appRoot, 'dist/rag/hybrid-retriever.service.js'));
const { PrismaService } = await import('@nathapp/nestjs-prisma').then(
  (m) => m.PrismaService,
);

const app = await AppFactory.createFastifyApp(AppModule, { logger: false });
const prisma = app.get(PrismaService);
const hybridRetriever = app.get(HybridRetrieverService);

const evalProjectId = process.env.RAG_EVAL_PROJECT_ID ?? 'proj_eval_001';

// Verify project exists
const project = await prisma.client.project.findUnique({ where: { id: evalProjectId } });
if (!project) {
  console.error(`❌ Evaluation project "${evalProjectId}" not found. Run seed:prod first.`);
  await app.close();
  process.exit(1);
}

// Seed documents — realistic content matching each expectedDocId
const evalDocuments = [
  // Docs (doc-001 to doc-028)
  { sourceId: 'doc-001', source: 'doc' as const, content: 'How to configure JWT token refresh. Configure the refresh token expiration in your IdP settings. For Auth0, use the refresh_token.rotation.reuse interval.' },
  { sourceId: 'doc-002', source: 'doc' as const, content: 'OAuth2 token expiration and refresh flow. Access tokens expire after 1 hour by default. Implement refresh token rotation to maintain sessions securely.' },
  { sourceId: 'doc-003', source: 'doc' as const, content: 'Null pointer exception in authentication service. The NPE occurs when currentUser is null after JWT validation passes but before session lookup.' },
  { sourceId: 'doc-004', source: 'doc' as const, content: 'Database connection pool settings. Set max pool size to 2x CPU cores. For PostgreSQL: max_connections=200, idle_in_transaction_session_timeout=60s.' },
  { sourceId: 'doc-005', source: 'doc' as const, content: 'Load balancer health check endpoint. Configure /healthz to return 200 with {"status":"ok"}. Set interval to 10s, threshold 3 failures for auto-removal.' },
  { sourceId: 'doc-006', source: 'doc' as const, content: 'Multi-region deployment setup. Deploy to 3 regions (us-east-1, eu-west-1, ap-southeast-1). Use Route 53 geolocation routing for latency-based routing.' },
  { sourceId: 'doc-007', source: 'doc' as const, content: 'API rate limiting configuration. Apply token bucket algorithm: 1000 req/min per API key. Use Redis sliding window for distributed rate limiting.' },
  { sourceId: 'doc-008', source: 'doc' as const, content: 'Docker container restart policy. Set restart-policy to unless-stopped. For long-running services use --restart unless-stopped --restart-backoff 1s --restart-max 10.' },
  { sourceId: 'doc-009', source: 'doc' as const, content: 'File upload size limit exceeded. Default limit is 10MB. Increase via fastifyMultipart: limits { fileSize: 52428800 } for 50MB uploads.' },
  { sourceId: 'doc-010', source: 'doc' as const, content: 'Deployment rollback procedure. Step 1: kubectl rollout undo deployment/api. Step 2: verify with kubectl rollout status. Step 3: notify on-call.' },
  { sourceId: 'doc-011', source: 'doc' as const, content: 'GraphQL query depth limit. Implement max depth rule at schema level: createComplexityLimitRule(1000). Validate cost analysis for expensive fields.' },
  { sourceId: 'doc-012', source: 'doc' as const, content: 'Currency conversion rates outdated. Refresh rates every 4 hours from exchangerate-api.com. Cache with ETag support. Fallback to last known rate on API failure.' },
  { sourceId: 'doc-013', source: 'doc' as const, content: 'Query parameter injection prevention. Always use parameterized queries. Never interpolate user input into SQL or GraphQL queries. Validate with zod schemas.' },
  { sourceId: 'doc-014', source: 'doc' as const, content: 'gRPC streaming backpressure. Implement bidirectional flow control. Use MAX_WINDOW_SIZE=65536 and handle GOAWAY frames gracefully for reconnection.' },
  { sourceId: 'doc-015', source: 'doc' as const, content: 'Payment webhook retry logic. Implement idempotent webhook handler using webhook ID. Acknowledge within 5s, process async. Retry with exponential backoff: 1m, 5m, 30m, 2h.' },
  { sourceId: 'doc-016', source: 'doc' as const, content: 'Mobile app push notification token. Store FCM/APNs tokens per device per user. Delete on app uninstall using silent push to detect stale tokens.' },
  { sourceId: 'doc-017', source: 'doc' as const, content: 'Timezone handling for scheduled tasks. Store all timestamps in UTC. Convert to user timezone in presentation layer using Intl.DateTimeFormat.' },
  { sourceId: 'doc-018', source: 'doc' as const, content: 'S3 bucket lifecycle policy. Configure transition to IA after 30 days, Glacier after 90 days. Set expiration for temporary uploads based on prefix.' },
  { sourceId: 'doc-019', source: 'doc' as const, content: 'Tracing span context propagation. Use W3C TraceContext format. Propagate traceparent header across service boundaries. Sample rate: 10% for normal, 100% for errors.' },
  { sourceId: 'doc-020', source: 'doc' as const, content: 'API versioning strategy. Use URL path versioning: /api/v1/, /api/v2/. Maintain backward compatibility within major version. Announce deprecations 90 days in advance.' },
  { sourceId: 'doc-021', source: 'doc' as const, content: 'Elasticsearch index mapping update. Use reindex API for mapping changes. Alias swap: POST /_aliases with { "actions": [{ "add": { "index": "logs-v2", "alias": "logs" }}] }.' },
  { sourceId: 'doc-022', source: 'doc' as const, content: 'Service mesh mTLS configuration. Enable permissive mode first, then strict. Use auto-pilot SDS for certificate rotation every 24h. Verify with openssl s_client -alpn istion.' },
  { sourceId: 'doc-023', source: 'doc' as const, content: 'Log aggregation query syntax. Use Lucene query syntax: level:ERROR AND service:api AND timestamp:[NOW-1h TO NOW]. Save frequently used queries as aliases.' },
  { sourceId: 'doc-024', source: 'doc' as const, content: 'Inbound webhook signature verification. Verify HMAC-SHA256 signature from X-Signature header. Reject requests older than 5 minutes using timestamp header.' },
  { sourceId: 'doc-025', source: 'doc' as const, content: 'Message queue consumer group rebalance. Implement graceful shutdown with rebalance. Use commit strategy: at-least-once for idempotent consumers.' },
  { sourceId: 'doc-026', source: 'doc' as const, content: 'Secrets manager rotation policy. Rotate secrets every 30 days automatically. Use Lambda rotation function with 3-step rotation: create, set, test.' },
  { sourceId: 'doc-027', source: 'doc' as const, content: 'Batch job retry exponential backoff. Retry with jitter: delay = min(cap, base * 2^attempt + random_jitter). Cap at 10 minutes. Max 5 retry attempts.' },
  { sourceId: 'doc-028', source: 'doc' as const, content: 'Idempotency key deduplication window. Store idempotency keys in Redis with TTL=24h. Key format: idempotency:{userId}:{key}. Return cached response on duplicate.' },

  // Manuals (manual-001 to manual-010)
  { sourceId: 'manual-001', source: 'manual' as const, content: 'Docker container restart policy reference. Restart policies: no, on-failure[:N], always, unless-stopped. Use docker run --restart unless-stopped for services.' },
  { sourceId: 'manual-002', source: 'manual' as const, content: 'Database connection pool settings reference. PostgreSQL connection pool: use PgBouncer in transaction mode. Recommended pool_size=10, max_client_conn=100.' },
  { sourceId: 'manual-003', source: 'manual' as const, content: 'Load balancer health check configuration. AWS ALB health check: HTTP GET /healthz, interval 30s, timeout 5s, healthy threshold 2, unhealthy threshold 3.' },
  { sourceId: 'manual-004', source: 'manual' as const, content: 'Deployment rollback procedure guide. Kubernetes rollback: kubectl rollout undo deployment/<name>. Check status: kubectl rollout status deployment/<name>.' },
  { sourceId: 'manual-005', source: 'manual' as const, content: 'Multi-region deployment guide. AWS multi-region: Use CloudFront for global distribution. RDS cross-region read replicas for data locality.' },
  { sourceId: 'manual-006', source: 'manual' as const, content: 'S3 bucket lifecycle policy configuration. Lifecycle rules: Transition actions to Standard-IA after 30 days, One Zone-IA after 60 days, Glacier after 180 days.' },
  { sourceId: 'manual-007', source: 'manual' as const, content: 'API versioning best practices. URL versioning: /v1/, /v2/. Header versioning: Accept: application/vnd.api+v2.json. Never break existing clients within major version.' },
  { sourceId: 'manual-008', source: 'manual' as const, content: 'Service mesh mTLS configuration guide. Istio mtls mode STRICT. PeerAuthentication policy: mode: STRICT, portLevelConfig for specific ports.' },
  { sourceId: 'manual-009', source: 'manual' as const, content: 'Database migration rollback guide. Step 1: Identify last good migration. Step 2: Run migration down. Step 3: Verify data integrity. Step 4: redeploy.' },
  { sourceId: 'manual-010', source: 'manual' as const, content: 'Secrets manager rotation guide. AWS Secrets Manager: Create Lambda rotation function. 3-step rotation template for RDS. Test rotation before enabling.' },

  // Tickets (ticket-001 to ticket-044)
  { sourceId: 'ticket-001', source: 'ticket' as const, content: 'Ticket #1: Null pointer exception in authentication service. User reports NPE when SSO session expires mid-request. Stack trace points to session.get() returning null.' },
  { sourceId: 'ticket-002', source: 'ticket' as const, content: 'Ticket #2: Memory leak in background worker. Background job processor memory grows ~50MB/hour. Heap dump shows retained objects in task queue.' },
  { sourceId: 'ticket-003', source: 'ticket' as const, content: 'Ticket #3: Slow query performance on dashboard. Dashboard page takes 8-12s to load. Slow query log shows missing index on project_id + created_at.' },
  { sourceId: 'ticket-004', source: 'ticket' as const, content: 'Ticket #4: Authentication fails with SSO provider. Okta SAML assertion fails validation. Certificate expiry date shows Jan 2024 (expired).' },
  { sourceId: 'ticket-005', source: 'ticket' as const, content: 'Ticket #5: File upload size limit exceeded. Users cannot upload attachments larger than 10MB. Error: "Payload too large" at nginx level.' },
  { sourceId: 'ticket-006', source: 'ticket' as const, content: 'Ticket #6: WebSocket disconnection issues. Users get disconnected after 5 minutes of inactivity. WebSocket ping timeout not configured.' },
  { sourceId: 'ticket-007', source: 'ticket' as const, content: 'Ticket #7: Email notification not sent. Password reset emails not arriving. SES sandbox mode blocks non-verified recipient emails.' },
  { sourceId: 'ticket-008', source: 'ticket' as const, content: 'Ticket #8: Search index corruption after crash. Search returns duplicate results after pod restart. Lucene index lock file not cleaned up.' },
  { sourceId: 'ticket-009', source: 'ticket' as const, content: 'Ticket #9: Admin panel access denied for new users. New PROJECT_DEVELOPER role cannot access admin endpoints. RBAC policy not updated for new role.' },
  { sourceId: 'ticket-010', source: 'ticket' as const, content: 'Ticket #10: Currency conversion rates outdated. Exchange rates cached indefinitely. Last update: 3 weeks ago. Users see stale prices.' },
  { sourceId: 'ticket-011', source: 'ticket' as const, content: 'Ticket #11: Export CSV includes deleted records. Soft-deleted tickets appear in CSV export. WHERE clause missing deletedAt IS NULL filter.' },
  { sourceId: 'ticket-012', source: 'ticket' as const, content: 'Ticket #12: Payment webhook retry logic. Webhook processor not acknowledging requests. PayPal webhooks being retried every 30 seconds for 24h.' },
  { sourceId: 'ticket-013', source: 'ticket' as const, content: 'Ticket #13: Dark mode toggle not persisting. Dark mode reverts to light on page reload. localStorage preference not being read on initialization.' },
  { sourceId: 'ticket-014', source: 'ticket' as const, content: 'Ticket #14: Audit log missing entries. Some admin actions not appearing in audit log. Audit middleware not wrapping all admin routes.' },
  { sourceId: 'ticket-015', source: 'ticket' as const, content: 'Ticket #15: How to configure JWT token refresh. Developer asking about implementing refresh token rotation. Current implementation uses long-lived tokens.' },
  { sourceId: 'ticket-016', source: 'ticket' as const, content: 'Ticket #16: OAuth2 token expiration handling. Access token expires silently. Client not handling 401 responses to trigger refresh flow.' },
  { sourceId: 'ticket-017', source: 'ticket' as const, content: 'Ticket #17: GraphQL query depth limit. Malicious client submitting deeply nested queries causing CPU spike. No depth limit validation on server.' },
  { sourceId: 'ticket-018', source: 'ticket' as const, content: 'Ticket #18: Redis cache invalidation timing. Cache not invalidated when ticket status changes. Publish/subscribe for cache invalidation not configured.' },
  { sourceId: 'ticket-019', source: 'ticket' as const, content: 'Ticket #19: gRPC streaming backpressure. Client overwhelmed by server pushing data too fast. No flow control window management implemented.' },
  { sourceId: 'ticket-020', source: 'ticket' as const, content: 'Ticket #20: Session fixation vulnerability. Session ID not regenerated on login. Attacker can hijack session using fixed session cookie.' },
  { sourceId: 'ticket-021', source: 'ticket' as const, content: 'Ticket #21: Feature flag evaluation delay. Feature flags take 30s to propagate after change. Flag evaluation reading from DynamoDB without caching.' },
  { sourceId: 'ticket-022', source: 'ticket' as const, content: 'Ticket #22: User permissions cache stale. Admin removes user from project but user retains access for 10 minutes. Cache TTL too high.' },
  { sourceId: 'ticket-023', source: 'ticket' as const, content: 'Ticket #23: Query parameter injection prevention. Input field "project" allows arbitrary characters. SQL injection possible via project name parameter.' },
  { sourceId: 'ticket-024', source: 'ticket' as const, content: 'Ticket #24: Mobile app push notification token. Push notifications not delivered to iOS devices. FCM vs APNs token handling bug in backend.' },
  { sourceId: 'ticket-025', source: 'ticket' as const, content: 'Ticket #25: CI pipeline cache miss every build. Build cache invalidated on every push. Cache key not including lock file hash correctly.' },
  { sourceId: 'ticket-026', source: 'ticket' as const, content: 'Ticket #26: Timezone handling for scheduled tasks. Scheduled tasks running at wrong time. Server using UTC but task scheduled in PST.' },
  { sourceId: 'ticket-027', source: 'ticket' as const, content: 'Ticket #27: Dark mode toggle not persisting. Dark mode setting reverts on navigation. React context not persisting to localStorage correctly.' },
  { sourceId: 'ticket-028', source: 'ticket' as const, content: 'Ticket #28: Memory leak in background worker. Worker process memory grows unbounded. Event listeners accumulating without cleanup.' },
  { sourceId: 'ticket-029', source: 'ticket' as const, content: 'Ticket #29: Authentication fails with SSO provider. ADFS claim mapping incorrect. User role not populated from SAML assertion correctly.' },
  { sourceId: 'ticket-030', source: 'ticket' as const, content: 'Ticket #30: Tracing span context propagation. Distributed traces break at API gateway. W3C traceparent header not propagated to downstream services.' },
  { sourceId: 'ticket-031', source: 'ticket' as const, content: 'Ticket #31: Admin panel access denied for new users. RBAC roles updated but permission matrix not reloaded. Server restart required to apply new roles.' },
  { sourceId: 'ticket-032', source: 'ticket' as const, content: 'Ticket #32: Kanban board drag drop lag. Drag and drop has 500ms delay. WebSocket events not throttled during rapid card movements.' },
  { sourceId: 'ticket-033', source: 'ticket' as const, content: 'Ticket #33: API rate limiting configuration. Rate limiter not applied to /api/internal/* endpoints. Internal API calls being rate limited inconsistently.' },
  { sourceId: 'ticket-034', source: 'ticket' as const, content: 'Ticket #34: User permissions cache stale. Cache invalidation not triggered on project membership change. Redis SETEX TTL of 5 minutes too aggressive.' },
  { sourceId: 'ticket-035', source: 'ticket' as const, content: 'Ticket #35: Database migration rollback. Migration v042 failed during deploy. Need to rollback to v041 state before redeploy.' },
  { sourceId: 'ticket-036', source: 'ticket' as const, content: 'Ticket #36: Message queue consumer group rebalance. Consumer group rebalancing every 30 seconds. Max poll interval exceeded due to slow processing.' },
  { sourceId: 'ticket-037', source: 'ticket' as const, content: 'Ticket #37: Session fixation vulnerability. CSRF token not validated on login. Session fixation attack possible via pre-existing session cookie.' },
  { sourceId: 'ticket-038', source: 'ticket' as const, content: 'Ticket #38: GraphQL subscription reconnect. Subscriptions disconnect on network blip. Client not implementing exponential backoff reconnection.' },
  { sourceId: 'ticket-039', source: 'ticket' as const, content: 'Ticket #39: Access token refresh race condition. Multiple concurrent token refresh requests. Race condition in token refresh mutex.' },
  { sourceId: 'ticket-040', source: 'ticket' as const, content: 'Ticket #40: Search index corruption after crash. Elasticsearch index in red status. Missing replica shards after node crash.' },
  { sourceId: 'ticket-041', source: 'ticket' as const, content: 'Ticket #41: Batch job retry exponential backoff. Batch job retries immediately without delay. RetryConfig not applied for transient failures.' },
  { sourceId: 'ticket-042', source: 'ticket' as const, content: 'Ticket #42: Idempotency key deduplication window. Duplicate webhook delivery after timeout. Same idempotency key processed multiple times.' },
  { sourceId: 'ticket-043', source: 'ticket' as const, content: 'Ticket #43: Redis cache invalidation timing. Cache not invalidated on content update. Event published but subscriber not receiving invalidation event.' },
  { sourceId: 'ticket-044', source: 'ticket' as const, content: 'Ticket #44: Memory leak in background worker. Worker grows 200MB/day in production. Memory profiler shows unbounded queue growth.' },
];

let indexed = 0;
let failed = 0;

for (const doc of evalDocuments) {
  try {
    await hybridRetriever.indexDocument(evalProjectId, {
      source: doc.source,
      sourceId: doc.sourceId,
      content: doc.content,
      metadata: { type: 'eval', indexed: new Date().toISOString() },
    });
    indexed++;
    if (indexed % 20 === 0) process.stdout.write(`\n  Indexed ${indexed}/${evalDocuments.length}...`);
  } catch (err) {
    console.warn(`  ⚠ Failed to index ${doc.sourceId}: ${(err as Error).message}`);
    failed++;
  }
}

console.log(`\n✅ Seeded ${indexed} evaluation documents (${failed} failed) into "${evalProjectId}"`);
await app.close();

if (failed > indexed) {
  console.error(`⚠️  More failures (${failed}) than successes (${indexed}). Check error logs.`);
  process.exit(1);
}
