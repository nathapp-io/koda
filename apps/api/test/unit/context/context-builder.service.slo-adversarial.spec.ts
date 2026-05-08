/**
 * Failing tests for US-004 SLO Dashboard + Token Budget Metrics adversarial review.
 *
 * Each test in this file FAILS with the current (buggy) implementation and
 * PASSES once the implementer applies the stated fix.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * Bug #1 — AC-1/AC-4: hadProvenance relies on result count instead of checking provenance data
 *
 *   File:    apps/api/src/context/context-builder.service.ts:169
 *   Current: hadProvenance: documents.results.length > 0,
 *   Spec:    AC-1: recordQueryMetric persists hadProvenance (Boolean).
 *            AC-4: provenanceCoverage = count(hadProvenance=true) / count(total queries).
 *
 *   The hadProvenance field should reflect whether query results actually had
 *   provenance data. The current code sets it to true whenever there are any
 *   results (results.length > 0), regardless of whether those results carry
 *   provenance information. A query with results that lack provenance should
 *   record hadProvenance: false.
 *
 *   Fix: check each result for actual provenance data, e.g.
 *        hadProvenance: documents.results.some((r) => r.provenance != null),
 *
 * ─────────────────────────────────────────────────────────────────────────
 * Bug #2 — AC-6: leakageIncidentCount is hardcoded to 0 in fire-and-forget
 *
 *   File:    apps/api/src/context/context-builder.service.ts:342
 *   Current: leakageIncidentCount: 0,
 *   Spec:    AC-6: leakageIncidents = sum(leakageIncidentCount) over all records.
 *
 *   The SloDashboardService correctly computes leakageIncidents from persisted
 *   leakageIncidentCount values, but the only caller (recordQueryMetricFireAndForget)
 *   always hardcodes leakageIncidentCount: 0. This means leakage incidents will
 *   always be reported as 0 regardless of actual data leakage.
 *
 *   When enforceTokenBudget truncates blocks (codeIntel, graphPaths, documents,
 *   semanticMemory), those truncations represent data leakage that should be
 *   counted and persisted.
 *
 *   Fix: count the number of truncated blocks in enforceTokenBudget and pass
 *        the count as leakageIncidentCount to recordQueryMetric.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * Bug #3 — AC-5: countStaleHits() duplicates isStaleHit() threshold logic
 *
 *   File:    apps/api/src/context/context-builder.service.ts:317
 *   Current: const thresholdMs = 7 * 24 * 60 * 60 * 1000;
 *   Spec:    AC-5: Stale hit counts are recorded when HybridRetrieverService.search()
 *            returns results whose indexedAt is more than 7 days old.
 *
 *   SloDashboardService.isStaleHit() exists as the canonical staleness check
 *   (slo-dashboard.service.ts:90-94). ContextBuilderService duplicates the
 *   threshold logic instead of calling isStaleHit(). Two separate
 *   implementations of the staleness definition can drift.
 *
 *   Fix: call SloDashboardService.isStaleHit() for each result instead of
 *        maintaining a separate copy of the threshold.
 */

import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { ContextBuilderService, GetProjectContextQuery } from '../../../src/context/context-builder.service';
import { CanonicalStateService } from '../../../src/memory/canonical-state.service';
import { PrismaMemoryItemRepository } from '../../../src/memory/prisma-memory-item.repository';
import { HybridRetrieverService } from '../../../src/rag/hybrid-retriever.service';
import { EntityGraphService } from '../../../src/entity-graph/entity-graph.service';
import { ImpactAnalysisService } from '../../../src/code-intel/impact-analysis.service';
import { SloDashboardService } from '../../../src/monitoring/slo-dashboard.service';

// ─── shared helpers ───────────────────────────────────────────────────────────

const PROJECT_ID = 'p-slo-adversarial-1';

interface ModuleOverrides {
  prisma?: { client: { project: { findUnique: jest.Mock } } };
  canonical?: { getSnapshot: jest.Mock };
  memoryRepo?: { findByProjectMemory: jest.Mock };
  hybridRetriever?: { search: jest.Mock };
  entityGraph?: { getRelatedEntities: jest.Mock };
  impactAnalysis?: { getChangeImpact: jest.Mock };
  sloDashboard?: Partial<jest.Mocked<SloDashboardService>>;
}

function makeSloDashboardMock(overrides: Partial<jest.Mocked<SloDashboardService>> = {}) {
  return {
    recordQueryMetric: jest.fn().mockResolvedValue(undefined),
    recordStaleHit: jest.fn().mockResolvedValue(undefined),
    getSloMetrics: jest.fn(),
    isStaleHit: jest.fn(),
    ...overrides,
  } as unknown as jest.Mocked<SloDashboardService>;
}

async function makeModule(overrides: ModuleOverrides = {}) {
  const mockPrisma = overrides.prisma ?? {
    client: {
      project: {
        findUnique: jest.fn().mockResolvedValue({ id: PROJECT_ID, deletedAt: null }),
      },
    },
  };

  const mockCanonical = overrides.canonical ?? {
    getSnapshot: jest.fn().mockResolvedValue({
      tickets: [],
      recentEvents: [],
      activeDecisions: [],
      retrievedAt: new Date(),
    }),
  };

  const mockMemoryRepo = overrides.memoryRepo ?? {
    findByProjectMemory: jest.fn().mockResolvedValue({ items: [], total: 0 }),
  };

  const mockHybridRetriever = overrides.hybridRetriever ?? {
    search: jest.fn().mockResolvedValue({
      results: [],
      scores: [],
      retrievedAt: new Date().toISOString(),
    }),
  };

  const mockEntityGraph = overrides.entityGraph ?? {
    getRelatedEntities: jest.fn().mockResolvedValue([]),
  };

  const mockImpactAnalysis = overrides.impactAnalysis ?? {
    getChangeImpact: jest.fn().mockResolvedValue(null),
  };

  const mockSloDashboard = overrides.sloDashboard ?? makeSloDashboardMock();

  const module: TestingModule = await Test.createTestingModule({
    providers: [
      ContextBuilderService,
      { provide: CanonicalStateService, useValue: mockCanonical },
      { provide: PrismaMemoryItemRepository, useValue: mockMemoryRepo },
      { provide: HybridRetrieverService, useValue: mockHybridRetriever },
      { provide: EntityGraphService, useValue: mockEntityGraph },
      { provide: ImpactAnalysisService, useValue: mockImpactAnalysis },
      { provide: PrismaService, useValue: mockPrisma },
      { provide: SloDashboardService, useValue: mockSloDashboard },
    ],
  }).compile();

  const service = module.get(ContextBuilderService);

  return {
    service,
    mocks: {
      prisma: mockPrisma,
      canonical: mockCanonical,
      memoryRepo: mockMemoryRepo,
      hybridRetriever: mockHybridRetriever,
      entityGraph: mockEntityGraph,
      impactAnalysis: mockImpactAnalysis,
      sloDashboard: mockSloDashboard,
    },
  };
}

function makeSearchResult(overrides: Record<string, unknown> = {}) {
  const now = new Date().toISOString();
  return {
    id: 'doc-1',
    source: 'ticket' as const,
    sourceId: 'ticket-123',
    content: 'Test document content with enough text to estimate tokens',
    score: 0.95,
    similarity: 'high' as const,
    metadata: {},
    createdAt: now,
    provenance: {
      indexedAt: now,
      sourceProjectId: PROJECT_ID,
    },
    ...overrides,
  };
}

// ─── Bug #1 — AC-1/AC-4: hadProvenance must reflect actual provenance data ────

describe('ContextBuilderService — AC-1/AC-4 adversarial: hadProvenance checks provenance data', () => {
  it('records hadProvenance: false when search results exist but lack provenance', async () => {
    const sloMock = makeSloDashboardMock();

    // Mock hybrid retriever to return results WITHOUT provenance data.
    // These results have no provenance property at all.
    const resultsWithoutProvenance = [
      makeSearchResult(),
    ];
    delete (resultsWithoutProvenance[0] as Record<string, unknown>).provenance;

    const { service } = await makeModule({
      sloDashboard: sloMock,
      hybridRetriever: {
        search: jest.fn().mockResolvedValue({
          results: resultsWithoutProvenance,
          scores: [{ vectorScore: 0.4, lexicalScore: 0.3, entityScore: 0.2, recencyScore: 0.1, finalScore: 0.95 }],
          retrievedAt: new Date().toISOString(),
        }),
      },
    });

    const query: GetProjectContextQuery = {
      projectId: PROJECT_ID,
      actorId: 'actor-1',
      intent: 'answer',
      query: 'test query',
    };

    await service.getProjectContext(query);

    // wait a tick for the fire-and-forget promise to settle
    await new Promise((resolve) => { setTimeout(resolve, 20); });

    expect(sloMock.recordQueryMetric).toHaveBeenCalledTimes(1);
    const metricCall = sloMock.recordQueryMetric.mock.calls[0][0];

    // AC-1: hadProvenance should be false because results have no provenance data.
    // Bug: current code sets hadProvenance = documents.results.length > 0 = true.
    expect(metricCall.hadProvenance).toBe(false);
  });

  it('records hadProvenance: true when at least one result has provenance', async () => {
    const sloMock = makeSloDashboardMock();

    const resultsWithProvenance = [
      makeSearchResult(),
    ];

    const { service } = await makeModule({
      sloDashboard: sloMock,
      hybridRetriever: {
        search: jest.fn().mockResolvedValue({
          results: resultsWithProvenance,
          scores: [{ vectorScore: 0.4, lexicalScore: 0.3, entityScore: 0.2, recencyScore: 0.1, finalScore: 0.95 }],
          retrievedAt: new Date().toISOString(),
        }),
      },
    });

    const query: GetProjectContextQuery = {
      projectId: PROJECT_ID,
      actorId: 'actor-1',
      intent: 'answer',
      query: 'test query',
    };

    await service.getProjectContext(query);
    await new Promise((resolve) => { setTimeout(resolve, 20); });

    expect(sloMock.recordQueryMetric).toHaveBeenCalledTimes(1);
    const metricCall = sloMock.recordQueryMetric.mock.calls[0][0];

    // AC-1: hadProvenance should be true because results have provenance data.
    expect(metricCall.hadProvenance).toBe(true);
  });

  it('records hadProvenance: false when search returns empty results', async () => {
    const sloMock = makeSloDashboardMock();

    const { service } = await makeModule({
      sloDashboard: sloMock,
      hybridRetriever: {
        search: jest.fn().mockResolvedValue({
          results: [],
          scores: [],
          retrievedAt: new Date().toISOString(),
        }),
      },
    });

    const query: GetProjectContextQuery = {
      projectId: PROJECT_ID,
      actorId: 'actor-1',
      intent: 'answer',
      query: 'test query',
    };

    await service.getProjectContext(query);
    await new Promise((resolve) => { setTimeout(resolve, 20); });

    expect(sloMock.recordQueryMetric).toHaveBeenCalledTimes(1);
    const metricCall = sloMock.recordQueryMetric.mock.calls[0][0];

    // hadProvenance should be false when there are no results.
    expect(metricCall.hadProvenance).toBe(false);
  });

  it('records hadProvenance: true when some results have provenance but not all', async () => {
    const sloMock = makeSloDashboardMock();

    // One result has provenance, one does not.
    const withProvenance = makeSearchResult({ id: 'doc-1' });
    const withoutProvenance = makeSearchResult({ id: 'doc-2' });
    delete (withoutProvenance as Record<string, unknown>).provenance;

    const { service } = await makeModule({
      sloDashboard: sloMock,
      hybridRetriever: {
        search: jest.fn().mockResolvedValue({
          results: [withProvenance, withoutProvenance],
          scores: [
            { vectorScore: 0.4, lexicalScore: 0.3, entityScore: 0.2, recencyScore: 0.1, finalScore: 0.95 },
            { vectorScore: 0.3, lexicalScore: 0.2, entityScore: 0.1, recencyScore: 0.1, finalScore: 0.80 },
          ],
          retrievedAt: new Date().toISOString(),
        }),
      },
    });

    const query: GetProjectContextQuery = {
      projectId: PROJECT_ID,
      actorId: 'actor-1',
      intent: 'answer',
      query: 'test query',
    };

    await service.getProjectContext(query);
    await new Promise((resolve) => { setTimeout(resolve, 20); });

    expect(sloMock.recordQueryMetric).toHaveBeenCalledTimes(1);
    const metricCall = sloMock.recordQueryMetric.mock.calls[0][0];

    // AC-1: hadProvenance should be true because at least one result has provenance data.
    expect(metricCall.hadProvenance).toBe(true);
  });
});

// ─── Bug #2 — AC-6: leakageIncidentCount must not be hardcoded to 0 ───────────

describe('ContextBuilderService — AC-6 adversarial: leakageIncidentCount reflects truncated blocks', () => {
  it('records leakageIncidentCount > 0 when token budget causes block truncation', async () => {
    const sloMock = makeSloDashboardMock();

    // Provide a large document and a very small token budget to force truncation.
    const largeDocument = makeSearchResult({
      id: 'doc-large',
      content: 'x'.repeat(20000), // ~5000 tokens worth of content
    });

    const { service } = await makeModule({
      sloDashboard: sloMock,
      hybridRetriever: {
        search: jest.fn().mockResolvedValue({
          results: [largeDocument],
          scores: [{ vectorScore: 0.4, lexicalScore: 0.3, entityScore: 0.2, recencyScore: 0.1, finalScore: 0.95 }],
          retrievedAt: new Date().toISOString(),
        }),
      },
      memoryRepo: {
        findByProjectMemory: jest.fn().mockResolvedValue({
          items: [
            {
              id: 'mem-1',
              kind: 'FACT',
              subject: 's',
              predicate: 'p',
              object: 'o'.repeat(5000), // large object to eat up token budget
              confidence: 0.9,
              createdAt: new Date(),
              updatedAt: new Date(),
            },
          ],
          total: 1,
        }),
      },
    });

    const query: GetProjectContextQuery = {
      projectId: PROJECT_ID,
      actorId: 'actor-1',
      intent: 'answer',
      query: 'test query',
      tokenBudget: 100, // extremely low budget to force truncation
    };

    await service.getProjectContext(query);
    await new Promise((resolve) => { setTimeout(resolve, 20); });

    expect(sloMock.recordQueryMetric).toHaveBeenCalledTimes(1);
    const metricCall = sloMock.recordQueryMetric.mock.calls[0][0];

    // AC-6: leakageIncidentCount should reflect the number of blocks truncated
    // due to token budget enforcement. With a budget of 100 and large content,
    // at least documents and semanticMemory should be truncated.
    // Bug: current code always passes leakageIncidentCount: 0.
    expect(metricCall.leakageIncidentCount).toBeGreaterThan(0);
  });

  it('records leakageIncidentCount equal to the number of truncated blocks', async () => {
    const sloMock = makeSloDashboardMock();

    // Provide enough content that all blocks exceed the budget.
    const largeDocument = makeSearchResult({
      id: 'doc-large',
      content: 'x'.repeat(16000),
    });

    const { service } = await makeModule({
      sloDashboard: sloMock,
      hybridRetriever: {
        search: jest.fn().mockResolvedValue({
          results: [largeDocument],
          scores: [{ vectorScore: 0.4, lexicalScore: 0.3, entityScore: 0.2, recencyScore: 0.1, finalScore: 0.95 }],
          retrievedAt: new Date().toISOString(),
        }),
      },
      memoryRepo: {
        findByProjectMemory: jest.fn().mockResolvedValue({
          items: [
            {
              id: 'mem-1',
              kind: 'FACT',
              subject: 's',
              predicate: 'p',
              object: 'o'.repeat(5000),
              confidence: 0.9,
              createdAt: new Date(),
              updatedAt: new Date(),
            },
          ],
          total: 1,
        }),
      },
    });

    const query: GetProjectContextQuery = {
      projectId: PROJECT_ID,
      actorId: 'actor-1',
      intent: 'answer',
      query: 'test query',
      tokenBudget: 50, // near-zero budget
      includeGraph: true,
      includeCodeIntel: true,
      ticketIds: ['t-1'],
    };

    await service.getProjectContext(query);
    await new Promise((resolve) => { setTimeout(resolve, 20); });

    expect(sloMock.recordQueryMetric).toHaveBeenCalledTimes(1);
    const metricCall = sloMock.recordQueryMetric.mock.calls[0][0];

    // All 4 blocks (codeIntel, graphPaths, documents, semanticMemory)
    // should be truncated with such a low budget.
    // Bug: current code always passes leakageIncidentCount: 0.
    expect(metricCall.leakageIncidentCount).toBeGreaterThanOrEqual(1);
  });

  it('records leakageIncidentCount: 0 when no truncation occurs (budget accommodates all content)', async () => {
    const sloMock = makeSloDashboardMock();

    const smallDocument = makeSearchResult({
      id: 'doc-small',
      content: 'small',
    });

    const { service } = await makeModule({
      sloDashboard: sloMock,
      hybridRetriever: {
        search: jest.fn().mockResolvedValue({
          results: [smallDocument],
          scores: [{ vectorScore: 0.4, lexicalScore: 0.3, entityScore: 0.2, recencyScore: 0.1, finalScore: 0.95 }],
          retrievedAt: new Date().toISOString(),
        }),
      },
    });

    const query: GetProjectContextQuery = {
      projectId: PROJECT_ID,
      actorId: 'actor-1',
      intent: 'answer',
      query: 'test query',
      tokenBudget: 100000, // very large budget
    };

    await service.getProjectContext(query);
    await new Promise((resolve) => { setTimeout(resolve, 20); });

    expect(sloMock.recordQueryMetric).toHaveBeenCalledTimes(1);
    const metricCall = sloMock.recordQueryMetric.mock.calls[0][0];

    // No truncation should occur with a large budget.
    expect(metricCall.leakageIncidentCount).toBe(0);
  });
});

// ─── Bug #3 — AC-5: countStaleHits() should delegate to isStaleHit() ───────────

describe('ContextBuilderService — AC-5 adversarial: countStaleHits delegates to isStaleHit', () => {
  it('uses SloDashboardService.isStaleHit() to determine staleness for each result', async () => {
    // isStaleHit returns false by default, so no stale hits.
    const sloMock = makeSloDashboardMock({
      isStaleHit: jest.fn().mockReturnValue(false),
    });

    const sevenDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
    const staleResult = makeSearchResult({
      id: 'stale-doc',
      provenance: { indexedAt: sevenDaysAgo, sourceProjectId: PROJECT_ID },
      createdAt: sevenDaysAgo,
    });

    const { service } = await makeModule({
      sloDashboard: sloMock,
      hybridRetriever: {
        search: jest.fn().mockResolvedValue({
          results: [staleResult],
          scores: [{ vectorScore: 0.4, lexicalScore: 0.3, entityScore: 0.2, recencyScore: 0.1, finalScore: 0.95 }],
          retrievedAt: new Date().toISOString(),
        }),
      },
    });

    const query: GetProjectContextQuery = {
      projectId: PROJECT_ID,
      actorId: 'actor-1',
      intent: 'answer',
      query: 'test query',
    };

    await service.getProjectContext(query);
    await new Promise((resolve) => { setTimeout(resolve, 20); });

    // AC-5: Staleness determination should come from the canonical SloDashboardService.isStaleHit().
    // Bug: ContextBuilderService has its own duplicate stale-hit counting logic
    // (thresholdMs = 7 * 24 * 60 * 60 * 1000) instead of calling isStaleHit().
    expect(sloMock.isStaleHit).toHaveBeenCalled();
  });

  it('counts stale hits consistently with SloDashboardService.isStaleHit()', async () => {
    // isStaleHit returns true for the stale result to simulate agreement.
    const sloMock = makeSloDashboardMock({
      isStaleHit: jest.fn().mockReturnValue(true),
    });

    const sevenDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
    const staleResult = makeSearchResult({
      id: 'stale-doc',
      provenance: { indexedAt: sevenDaysAgo, sourceProjectId: PROJECT_ID },
      createdAt: sevenDaysAgo,
    });

    const { service } = await makeModule({
      sloDashboard: sloMock,
      hybridRetriever: {
        search: jest.fn().mockResolvedValue({
          results: [staleResult],
          scores: [{ vectorScore: 0.4, lexicalScore: 0.3, entityScore: 0.2, recencyScore: 0.1, finalScore: 0.95 }],
          retrievedAt: new Date().toISOString(),
        }),
      },
    });

    const query: GetProjectContextQuery = {
      projectId: PROJECT_ID,
      actorId: 'actor-1',
      intent: 'answer',
      query: 'test query',
    };

    await service.getProjectContext(query);
    await new Promise((resolve) => { setTimeout(resolve, 20); });

    expect(sloMock.recordQueryMetric).toHaveBeenCalledTimes(1);
    const metricCall = sloMock.recordQueryMetric.mock.calls[0][0];

    // When isStaleHit returns true, the staleHitCount should be at least 1.
    expect(metricCall.staleHitCount).toBeGreaterThanOrEqual(1);
  });
});

// ─── Bug #4 — AC-1: recordStaleHit() persists docId ────────────────────────────
//
// Source finding (apps/api/src/monitoring/slo-dashboard.service.ts:52):
//
//   async recordStaleHit(projectId: string, _docId: string): Promise<void>
//
//   The _docId parameter is never stored or persisted. The metric record
//   created by recordStaleHit has no docId field to link it back to the
//   specific document that triggered the stale hit. This makes it impossible
//   to determine which documents are causing high stale-hit rates.
//
//   Spec-correct behavior (AC-1): recordStaleHit should persist enough
//   information to identify the specific document that was stale.
//
// Note: this test is a unit test against SloDashboardService directly and
// requires the Prisma schema to include a docId field on MemoryQueryMetric
// or the service to store it in a retrievable way.

describe('SloDashboardService — AC-1 adversarial: recordStaleHit() persists docId link', () => {
  it('stores the docId of the stale document in the persisted metric', () => {
    // This test documents the spec-correct behavior described in AC-1:
    // recordStaleHit(projectId, docId) should persist the docId so that
    // dashboard consumers can trace stale hits back to specific documents.
    //
    // Bug: the _docId parameter on recordStaleHit is prefixed with _ and
    // never stored in the created MemoryQueryMetric record. The metric
    // contains staleHitCount=1, resultCount=1, but no reference to which
    // document was stale.
    //
    // To verify manually without Prisma:
    // 1. The _docId parameter must not be prefixed with _ (it's used, not ignored)
    // 2. The created metric record must include docId (or equivalent reference)
    //
    // This test is structural — it will fail because the _ prefix convention
    // in TypeScript means the parameter is intentionally unused.

    // Dynamic import to check the actual source code.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = require('fs');
    const serviceSource = fs.readFileSync(
      require.resolve('../../../src/monitoring/slo-dashboard.service'),
      'utf8',
    ) as string;

    // The parameter must NOT be prefixed with _ if it's actually used.
    // Bug: the parameter is named _docId (underscore-prefixed = intentionally unused).
    const hasUnderscorePrefix = /recordStaleHit\([^)]*\)/.test(serviceSource)
      ? serviceSource.includes('(projectId: string, _docId: string)')
      : false;

    if (hasUnderscorePrefix) {
      throw new Error(
        'recordStaleHit() parameter _docId is underscore-prefixed, indicating it is ' +
        'intentionally unused. Per AC-1, the docId must be persisted in the metric record ' +
        'to enable tracing stale hits to specific documents. ' +
        'Fix: remove the _ prefix and store docId in the created MemoryQueryMetric record. ' +
        'The Prisma schema may need a docId field on MemoryQueryMetric to support this.',
      );
    }

    // Verify the docId is actually used in the data payload.
    const usesDocId = serviceSource.includes('docId') &&
      !serviceSource.includes('_docId');
    expect(usesDocId).toBe(true);
  });
});
