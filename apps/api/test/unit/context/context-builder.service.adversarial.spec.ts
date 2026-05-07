/**
 * Failing tests for adversarial review findings on ContextBuilderService.
 *
 * Each test in this file FAILS with the current (buggy) implementation and
 * PASSES once the implementer applies the stated fix.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * Bug #1 — AC-7: meta.tokensUsed excludes canonicalState token cost
 *
 *   File:    apps/api/src/context/context-builder.service.ts:128
 *   Current: const tokensUsed = estimateTokenCount(JSON.stringify(retrievedContext));
 *   Spec:    AC-7 refined, clause (4): "canonicalState block token cost is always
 *            included in tokensUsed and never causes truncation of other blocks."
 *
 *   The current line measures only the retrievedContext block. When canonicalState
 *   carries substantial data (tickets, activeDecisions, recentEvents), meta.tokensUsed
 *   reports a number that is far lower than the actual tokens serialised in the
 *   response. The TokenBudgetGate relies on meta.tokensUsed ≤ tokenBudget + 5 %;
 *   this bug makes the gate trivially pass even when the full response exceeds budget.
 *
 *   Fix: include canonicalState tokens in the tokensUsed calculation, e.g.
 *        estimateTokenCount(JSON.stringify({ tickets, recentEvents, activeDecisions }))
 *        + estimateTokenCount(JSON.stringify(retrievedContext))
 *
 * ─────────────────────────────────────────────────────────────────────────
 * Bug #2 — AC-9: error thrown for non-existent project has wrong code type
 *
 *   File:    apps/api/src/context/context-builder.service.ts:154
 *   Current: throw new NotFoundAppException({}, 'projects');
 *   Spec:    AC-9 refined: "error instance where error.code === 'PROJECT_NOT_FOUND'"
 *            (string, not the numeric 404 that NotFoundAppException.code returns).
 *
 *   NotFoundAppException inherits AppException whose .code getter returns the numeric
 *   CommonExceptionCode.NOT_FOUND (= 404), not the string 'PROJECT_NOT_FOUND'.
 *   Additionally, the PRD scope lists a custom ProjectNotFoundError class as an
 *   in-scope deliverable; no such class exists in the codebase.
 *
 *   Fix: create a ProjectNotFoundError class (a KodaError subclass) whose .code
 *        property equals the string 'PROJECT_NOT_FOUND', then throw it instead of
 *        NotFoundAppException.
 */

import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { ContextBuilderService, GetProjectContextQuery } from '../../../src/context/context-builder.service';
import { CanonicalStateService } from '../../../src/memory/canonical-state.service';
import { PrismaMemoryItemRepository } from '../../../src/memory/prisma-memory-item.repository';
import { HybridRetrieverService } from '../../../src/rag/hybrid-retriever.service';
import { EntityGraphService } from '../../../src/entity-graph/entity-graph.service';
import { ImpactAnalysisService } from '../../../src/code-intel/impact-analysis.service';
import { estimateTokenCount } from '../../../src/context/token-estimator';

// ─── shared helpers ───────────────────────────────────────────────────────────

const PROJECT_ID = 'p-adversarial-1';

interface ModuleOverrides {
  prisma?: { client: { project: { findUnique: jest.Mock } } };
  canonical?: { getSnapshot: jest.Mock };
  memoryRepo?: { findByProjectMemory: jest.Mock };
  hybridRetriever?: { search: jest.Mock };
  entityGraph?: { getRelatedEntities: jest.Mock };
  impactAnalysis?: { getChangeImpact: jest.Mock };
}

function makeModule(overrides: ModuleOverrides = {}) {
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

  return Test.createTestingModule({
    providers: [
      ContextBuilderService,
      { provide: CanonicalStateService, useValue: mockCanonical },
      { provide: PrismaMemoryItemRepository, useValue: mockMemoryRepo },
      { provide: HybridRetrieverService, useValue: mockHybridRetriever },
      { provide: EntityGraphService, useValue: mockEntityGraph },
      { provide: ImpactAnalysisService, useValue: mockImpactAnalysis },
      { provide: PrismaService, useValue: mockPrisma },
    ],
  }).compile();
}

// ─── Bug #1 — AC-7: meta.tokensUsed must include canonicalState token cost ────

describe('ContextBuilderService — AC-7 adversarial: meta.tokensUsed includes canonicalState tokens', () => {
  let service: ContextBuilderService;

  // canonicalState snapshot with substantial data so its serialised token cost
  // is meaningfully larger than the (empty) retrievedContext token cost.
  const heavyTickets = Array.from({ length: 5 }, (_, i) => ({
    id: `ticket-${i}`,
    number: i + 1,
    title: `A very detailed ticket title that adds real token weight ${i} — ${'x'.repeat(40)}`,
    status: 'OPEN',
    priority: 'HIGH',
  }));

  const heavyDecisions = Array.from({ length: 3 }, (_, i) => ({
    id: `decision-${i}`,
    title: `Decision title with enough text to matter ${'y'.repeat(40)} — ${i}`,
    createdAt: new Date('2025-01-01T00:00:00.000Z'),
  }));

  beforeEach(async () => {
    const module: TestingModule = await makeModule({
      canonical: {
        getSnapshot: jest.fn().mockResolvedValue({
          tickets: heavyTickets,
          recentEvents: [] as unknown[],
          activeDecisions: heavyDecisions,
          retrievedAt: new Date(),
        }),
      },
    });
    service = module.get(ContextBuilderService);
  });

  it('reports tokensUsed that is at least as large as the canonicalState token cost alone', async () => {
    // Compute what the canonicalState contribution should be.
    // The service must include this in meta.tokensUsed per AC-7 clause (4).
    const canonicalStateJson = JSON.stringify({
      tickets: heavyTickets,
      recentEvents: [],
      activeDecisions: heavyDecisions,
    });
    const expectedCanonicalTokens = estimateTokenCount(canonicalStateJson);

    // Sanity: confirm the canonical cost is non-trivial (> 50 tokens) so this
    // test is sensitive enough to catch the bug even with minor impl variations.
    expect(expectedCanonicalTokens).toBeGreaterThan(50);

    const query: GetProjectContextQuery = {
      projectId: PROJECT_ID,
      actorId: 'actor-1',
      intent: 'answer',
      // No query → retrievedContext.documents is empty → retrievedContext tokens are small
    };

    const result = await service.getProjectContext(query);

    // AC-7 clause (4): "canonicalState block token cost is always included in tokensUsed."
    // With the bug: tokensUsed = retrievedContextTokens only (a small number ~10–20)
    // With the fix: tokensUsed ≥ canonicalStateTokens (≫ 50)
    expect(result.meta.tokensUsed).toBeGreaterThanOrEqual(expectedCanonicalTokens);
  });

  it('reports tokensUsed equal to the sum of canonicalState + retrievedContext tokens', async () => {
    const query: GetProjectContextQuery = {
      projectId: PROJECT_ID,
      actorId: 'actor-1',
      intent: 'answer',
    };

    const result = await service.getProjectContext(query);

    // Compute what the full serialised response blocks look like.
    const canonicalTokens = estimateTokenCount(
      JSON.stringify({
        tickets: result.canonicalState.tickets,
        recentEvents: result.canonicalState.recentEvents,
        activeDecisions: result.canonicalState.activeDecisions,
      }),
    );
    const retrievedTokens = estimateTokenCount(JSON.stringify(result.retrievedContext));

    // The combined count must match meta.tokensUsed.
    // With the bug: tokensUsed = retrievedTokens (~10) ≠ canonicalTokens + retrievedTokens (~300+)
    expect(result.meta.tokensUsed).toBe(canonicalTokens + retrievedTokens);
  });
});

// ─── Bug #2 — AC-9: error code for missing project must be 'PROJECT_NOT_FOUND' ─

describe('ContextBuilderService — AC-9 adversarial: ProjectNotFoundError has code PROJECT_NOT_FOUND', () => {
  let service: ContextBuilderService;

  beforeEach(async () => {
    const module: TestingModule = await makeModule({
      prisma: {
        client: {
          project: {
            // Simulate a non-existent project (findUnique returns null)
            findUnique: jest.fn().mockResolvedValue(null),
          },
        },
      },
    });
    service = module.get(ContextBuilderService);
  });

  it('throws an error with code === "PROJECT_NOT_FOUND" (string) when projectId does not exist', async () => {
    const query: GetProjectContextQuery = {
      projectId: 'does-not-exist',
      actorId: 'actor-1',
      intent: 'answer',
    };

    // AC-9 refined: "error.code === 'PROJECT_NOT_FOUND'"
    // Bug: NotFoundAppException.code is the numeric 404, not the string 'PROJECT_NOT_FOUND'.
    let thrown: unknown;
    try {
      await service.getProjectContext(query);
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeDefined();
    expect((thrown as any).code).toBe('PROJECT_NOT_FOUND');
  });

  it('throws an error whose code is a string, not a numeric HTTP status', async () => {
    const query: GetProjectContextQuery = {
      projectId: 'does-not-exist',
      actorId: 'actor-1',
      intent: 'answer',
    };

    let thrown: unknown;
    try {
      await service.getProjectContext(query);
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeDefined();
    // The bug: NotFoundAppException.code returns the number 404.
    // The spec requires a string code: 'PROJECT_NOT_FOUND'.
    expect(typeof (thrown as any).code).toBe('string');
  });

  it('throws an error that is an instance of ProjectNotFoundError', async () => {
    // AC-9 refined: "error instanceof ProjectNotFoundError is true"
    // The PRD scope includes a ProjectNotFoundError class as a required deliverable.
    // Bug: no such class exists; the service throws a generic NotFoundAppException.

    // Dynamic import so a missing export causes a descriptive test failure
    // rather than a module-load crash at suite setup.
    let ProjectNotFoundError: new (...args: unknown[]) => unknown;
    try {
      // Expect the class to be exported from the context module's service or
      // a dedicated errors file alongside the service.
      const mod = await import('../../../src/context/context-builder.service');
      ProjectNotFoundError = (mod as any).ProjectNotFoundError;
      if (!ProjectNotFoundError) {
        throw new Error('ProjectNotFoundError is not exported from context-builder.service');
      }
    } catch {
      // If the import itself fails, throw a clear failure message.
      throw new Error(
        'ProjectNotFoundError class does not exist. ' +
        'AC-9 requires a custom ProjectNotFoundError (KodaError subclass) ' +
        'to be created and exported from the context module.',
      );
    }

    const query: GetProjectContextQuery = {
      projectId: 'does-not-exist',
      actorId: 'actor-1',
      intent: 'answer',
    };

    let thrown: unknown;
    try {
      await service.getProjectContext(query);
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeDefined();
    expect(thrown).toBeInstanceOf(ProjectNotFoundError);
  });
});
