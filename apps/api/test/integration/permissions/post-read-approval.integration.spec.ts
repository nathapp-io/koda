import request from 'supertest';
import type { NathApplication } from '@nathapp/nestjs-app';
import { grantKeys, seedWaitPolicy } from '../../../src/approvals/test-helpers/approval-fixtures';
import { PermissionCache } from '../../../src/permissions/permission-cache';
import type { GetProjectContextResponse } from '../../../src/context/context-builder.service';
import type { EvalSummary } from '../../../src/retrieval/evaluation.service';
import { fixtureDb } from '../../helpers/action-context';
import { bootHttpApp, data, resetThrottle } from '../../helpers/http-app';
import { seedFleetHttpAgent, seedFleetHttpWorld, type FleetHttpWorld } from '../../helpers/fleet-fixtures';
import { resetDb } from '../../helpers/reset-db';
import { canRunDbTests } from '../../helpers/test-environment';

const describeDb = canRunDbTests() ? describe : describe.skip;

describeDb('POST read routes do not open approval requests', () => {
  let app: NathApplication;
  let db: ReturnType<typeof fixtureDb>;
  let world: FleetHttpWorld;
  let agent: Awaited<ReturnType<typeof seedFleetHttpAgent>>;
  const server = () => app.getHttpServer();
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  beforeAll(async () => {
    const previousEmbeddingProvider = process.env.EMBEDDING_PROVIDER;
    process.env.EMBEDDING_PROVIDER = 'fake';
    try {
      await resetDb();
      app = await bootHttpApp({ registrationEnabled: true, ownerEmail: null });
    } finally {
      if (previousEmbeddingProvider === undefined) delete process.env.EMBEDDING_PROVIDER;
      else process.env.EMBEDDING_PROVIDER = previousEmbeddingProvider;
    }

    db = fixtureDb(app);
    world = await seedFleetHttpWorld(server(), db);
    agent = await seedFleetHttpAgent(server(), world.tokens.root);
    await grantKeys(db, { type: 'AGENT', id: agent.id }, [
      'project.read', 'context.query', 'kb.search', 'retrieval.evaluate',
    ], world.projectId);
    await app.get(PermissionCache).invalidate();
  }, 120_000);

  afterAll(async () => { await app?.close(); });

  beforeEach(async () => {
    resetThrottle(app);
    await db.approvalDecision.deleteMany();
    await db.approvalRequest.deleteMany();
    await db.approvalPolicy.deleteMany();
  });

  it.each([
    ['context.query', '/api/context/web/query', { query: 'approval read behavior' }],
    ['kb.search', '/api/projects/web/kb/search', { query: 'approval read behavior' }],
    ['retrieval.evaluate', '/api/projects/web/kb/evaluate/retrieval', {}],
  ] as const)('AC-9: %s returns its normal 200 response without an approval request under a seeded wait policy', async (key, path, body) => {
    await seedWaitPolicy(db, key, world.projectId);

    const response = await request(server()).post(path).set(auth(agent.apiKey)).send(body).expect(200);
    const result = data(response);

    if (key === 'context.query') {
      expect(result).toMatchObject({
        projectId: world.projectId,
        canonicalState: expect.any(Object),
        retrievedContext: expect.any(Object),
        provenance: expect.any(Object),
        meta: expect.any(Object),
      } satisfies Partial<GetProjectContextResponse>);
    } else if (key === 'kb.search') {
      expect(result).toMatchObject({
        results: expect.any(Array),
        scores: expect.any(Array),
        provenance: { retrievedAt: expect.any(String), sources: expect.any(Array) },
      } satisfies Partial<{
        results: unknown[];
        scores: unknown[];
        provenance: { retrievedAt: string; sources: unknown[] };
      }>);
    } else {
      expect(result).toMatchObject({
        precisionAt5_avg: expect.any(Number),
        precisionAt5_p50: expect.any(Number),
        precisionAt5_p95: expect.any(Number),
        totalQueries: expect.any(Number),
        results: expect.any(Array),
      } satisfies Partial<EvalSummary>);
    }
    expect(await db.approvalRequest.count()).toBe(0);
  });
});
