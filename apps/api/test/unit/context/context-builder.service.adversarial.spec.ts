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
 *
 * ─────────────────────────────────────────────────────────────────────────
 * Bug #3 — AC-10: Promise.all for canonicalState + semanticMemory has no try-catch
 *
 *   File:    apps/api/src/context/context-builder.service.ts:96–109
 *   Current: const [snapshot, semanticMemoryResult, documents] = await Promise.all([
 *              this.canonicalStateService.getSnapshot({ ... }),
 *              this.memoryItemRepository.findByProjectMemory({ ... }),
 *              this.fetchDocuments(query),
 *            ]);
 *   Spec:    AC-10: "All errors thrown by getProjectContext are KodaError subclasses
 *            and serialize to the ErrorEnvelope format."
 *
 *   getSnapshot() and findByProjectMemory() execute Prisma queries internally.
 *   A Prisma failure (PrismaClientKnownRequestError, PrismaClientUnknownRequestError,
 *   or any other infrastructure error) is NOT an AppException. Because the Promise.all
 *   is not wrapped in a try-catch, these raw errors escape getProjectContext()
 *   uncaught, violating AC-10.
 *
 *   Fix: wrap the Promise.all (or individual calls) in a try-catch block that
 *        converts non-AppException errors into an AppException subclass (e.g.
 *        InternalAppException) before re-throwing.
 */

import { Test, TestingModule } from '@nestjs/testing';
import { ContextBuilderService, GetProjectContextQuery } from '../../../src/context/context-builder.service';
import { CanonicalStateService } from '../../../src/memory/canonical-state.service';
import { PrismaMemoryItemRepository } from '../../../src/memory/prisma-memory-item.repository';
import { HybridRetrieverService } from '../../../src/rag/hybrid-retriever.service';
import { EntityGraphService } from '../../../src/entity-graph/entity-graph.service';
import { ImpactAnalysisService } from '../../../src/code-intel/impact-analysis.service';
import { estimateTokenCount } from '../../../src/context/token-estimator';
import { CONTEXT_REPOSITORY } from '../../../src/context/domain/context.domain';

// ─── shared helpers ───────────────────────────────────────────────────────────

const PROJECT_ID = 'p-adversarial-1';

interface ModuleOverrides {
  contextRepo?: { projectExistsAndNotDeleted: jest.Mock };
  canonical?: { getSnapshot: jest.Mock };
  memoryRepo?: { findByProjectMemory: jest.Mock };
  hybridRetriever?: { search: jest.Mock };
  entityGraph?: { getRelatedEntities: jest.Mock };
  impactAnalysis?: { getChangeImpact: jest.Mock };
}

function makeModule(overrides: ModuleOverrides = {}) {
  const mockContextRepo = overrides.contextRepo ?? {
    projectExistsAndNotDeleted: jest.fn().mockResolvedValue(true),
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
      { provide: CONTEXT_REPOSITORY, useValue: mockContextRepo },
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
      contextRepo: {
        // Simulate a non-existent project
        projectExistsAndNotDeleted: jest.fn().mockResolvedValue(false),
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

// ─── Bug #3 — AC-10: raw Prisma errors from Promise.all must be wrapped ──────

describe('ContextBuilderService — AC-10 adversarial: non-AppException errors from data layer are wrapped', () => {
  // AppException is the base class for all errors that serialize to ErrorEnvelope.
  // AC-10 requires getProjectContext() to only propagate AppException subclasses.
  // The bug: the Promise.all at line 96 has no try-catch, so Prisma errors escape
  // as raw Error instances, not AppException subclasses.

  async function buildService(overrides: ModuleOverrides): Promise<ContextBuilderService> {
    const module: TestingModule = await makeModule(overrides);
    return module.get(ContextBuilderService);
  }

  function makePrismaLikeError(message: string): Error {
    // Simulates a PrismaClientKnownRequestError: a plain infrastructure error
    // that is NOT an AppException subclass.
    const err = new Error(message);
    err.name = 'PrismaClientKnownRequestError';
    (err as any).code = 'P2025'; // Prisma "record not found" error code
    return err;
  }

  it('wraps a raw Error thrown by canonicalStateService.getSnapshot() into an AppException', async () => {
    // Import AppException to use as the instanceof check target.
    const { AppException } = await import('@nathapp/nestjs-common');

    const prismaError = makePrismaLikeError('An operation failed because it depends on one or more records');

    const service = await buildService({
      canonical: {
        getSnapshot: jest.fn().mockRejectedValue(prismaError),
      },
    });

    const query: GetProjectContextQuery = {
      projectId: PROJECT_ID,
      actorId: 'actor-1',
      intent: 'answer',
    };

    let thrown: unknown;
    try {
      await service.getProjectContext(query);
    } catch (err) {
      thrown = err;
    }

    // AC-10: error must be an AppException subclass (serializable to ErrorEnvelope).
    // Bug: the raw PrismaClientKnownRequestError propagates — it is NOT an AppException.
    expect(thrown).toBeDefined();
    expect(thrown).toBeInstanceOf(AppException);
  });

  it('wraps a raw Error thrown by memoryItemRepository.findByProjectMemory() into an AppException', async () => {
    const { AppException } = await import('@nathapp/nestjs-common');

    const prismaError = makePrismaLikeError('Connection to database lost');
    prismaError.name = 'PrismaClientUnknownRequestError';

    const service = await buildService({
      memoryRepo: {
        findByProjectMemory: jest.fn().mockRejectedValue(prismaError),
      },
    });

    const query: GetProjectContextQuery = {
      projectId: PROJECT_ID,
      actorId: 'actor-1',
      intent: 'answer',
    };

    let thrown: unknown;
    try {
      await service.getProjectContext(query);
    } catch (err) {
      thrown = err;
    }

    // AC-10: error must be an AppException subclass.
    // Bug: the raw error propagates uncaught from the unwrapped Promise.all.
    expect(thrown).toBeDefined();
    expect(thrown).toBeInstanceOf(AppException);
  });

  it('does not expose raw infrastructure error details when data layer throws', async () => {
    const { AppException } = await import('@nathapp/nestjs-common');

    const prismaError = makePrismaLikeError('Internal connection pool exhausted');

    const service = await buildService({
      canonical: {
        getSnapshot: jest.fn().mockRejectedValue(prismaError),
      },
    });

    const query: GetProjectContextQuery = {
      projectId: PROJECT_ID,
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
    // The thrown error must be an AppException so that the global exception filter
    // can serialize it to ErrorEnvelope. A raw Error would bypass the filter.
    expect(thrown).toBeInstanceOf(AppException);
    // The raw Prisma error itself must NOT be the top-level thrown value.
    expect(thrown).not.toBe(prismaError);
  });
});

// ─── Bug #4 — AC-10: non-NotFoundAppException AppException subclasses must be preserved ─
//
// Source finding (apps/api/src/context/context-builder.service.ts:3, :115):
//
//   The catch block at line 114 only re-throws NotFoundAppException. Any other
//   AppException subclass (e.g. ForbiddenAppException → HTTP 403, ValidationAppException
//   → HTTP 400) is swallowed and converted to InternalAppException (HTTP 500).
//   AppException is not imported, so the check `err instanceof AppException` is not
//   even available as a guard.
//
//   Spec-correct behavior (AC-10): ALL AppException subclasses must be re-thrown
//   as-is; only non-AppException errors should be wrapped in InternalAppException.

describe('ContextBuilderService — AC-10 adversarial: AppException subclasses from data layer are preserved', () => {
  async function buildService(overrides: ModuleOverrides): Promise<ContextBuilderService> {
    const module: TestingModule = await makeModule(overrides);
    return module.get(ContextBuilderService);
  }

  it('re-throws ForbiddenAppException thrown by canonicalStateService.getSnapshot() unchanged', async () => {
    const { ForbiddenAppException } = await import('@nathapp/nestjs-common');

    const forbiddenError = new ForbiddenAppException({}, 'context');

    const service = await buildService({
      canonical: {
        getSnapshot: jest.fn().mockRejectedValue(forbiddenError),
      },
    });

    const query: GetProjectContextQuery = {
      projectId: PROJECT_ID,
      actorId: 'actor-1',
      intent: 'answer',
    };

    let thrown: unknown;
    try {
      await service.getProjectContext(query);
    } catch (err) {
      thrown = err;
    }

    // AC-10: ForbiddenAppException must propagate as-is (HTTP 403).
    // Bug: the catch block converts it to InternalAppException (HTTP 500).
    expect(thrown).toBeDefined();
    expect(thrown).toBeInstanceOf(ForbiddenAppException);
    expect(thrown).toBe(forbiddenError);
  });

  it('re-throws ValidationAppException thrown by memoryItemRepository.findByProjectMemory() unchanged', async () => {
    const { ValidationAppException } = await import('@nathapp/nestjs-common');

    const validationError = new ValidationAppException({}, 'context');

    const service = await buildService({
      memoryRepo: {
        findByProjectMemory: jest.fn().mockRejectedValue(validationError),
      },
    });

    const query: GetProjectContextQuery = {
      projectId: PROJECT_ID,
      actorId: 'actor-1',
      intent: 'answer',
    };

    let thrown: unknown;
    try {
      await service.getProjectContext(query);
    } catch (err) {
      thrown = err;
    }

    // AC-10: ValidationAppException must propagate as-is (HTTP 400).
    // Bug: the catch block converts it to InternalAppException (HTTP 500).
    expect(thrown).toBeDefined();
    expect(thrown).toBeInstanceOf(ValidationAppException);
    expect(thrown).toBe(validationError);
  });

  it('does not convert a ForbiddenAppException to InternalAppException', async () => {
    const { ForbiddenAppException, InternalAppException } = await import('@nathapp/nestjs-common');

    const forbiddenError = new ForbiddenAppException({}, 'context');

    const service = await buildService({
      canonical: {
        getSnapshot: jest.fn().mockRejectedValue(forbiddenError),
      },
    });

    const query: GetProjectContextQuery = {
      projectId: PROJECT_ID,
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
    // The thrown value must NOT be an InternalAppException — that would mask the real error type.
    expect(thrown).not.toBeInstanceOf(InternalAppException);
    expect(thrown).toBeInstanceOf(ForbiddenAppException);
  });
});
