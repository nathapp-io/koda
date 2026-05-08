/**
 * Failing test for AC-7 adversarial finding:
 *
 * Bug (context-builder.service.ts:227): Token budget truncation does not enforce the correct
 * priority order. When codeIntel and graphPaths are both present and together exceed the budget,
 * but codeIntel alone is enough to bring the total within budget, the service must remove
 * codeIntel first (lowest priority). The current implementation instead keeps codeIntel
 * (because it fits at the time it is checked) and removes graphPaths instead.
 *
 * AC-7 priority order (lowest removed first):
 *   codeIntel → graphPaths → documents → semanticMemory
 * canonicalState blocks (tickets, activeDecisions) are NEVER removed.
 *
 * Scenario:
 *   budget=275, semanticTokens=100, docTokens=100, codeIntelTokens=60, graphTokens=60
 *   total=320 > 275 → truncation required
 *   Correct: remove codeIntel (60). Remaining=260 ≤ 275. Done.
 *   Buggy:   codeIntel fits (260 ≤ 275), so it is kept; graphPaths then puts total at 320
 *            which exceeds 275, so graphPaths is removed instead.
 *
 * This test FAILS with the current (buggy) implementation and PASSES once the fix is in place.
 */

import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { ContextBuilderService, GetProjectContextQuery } from '../../../src/context/context-builder.service';
import { CanonicalStateService } from '../../../src/memory/canonical-state.service';
import { PrismaMemoryItemRepository } from '../../../src/memory/prisma-memory-item.repository';
import { HybridRetrieverService } from '../../../src/rag/hybrid-retriever.service';
import { EntityGraphService } from '../../../src/entity-graph/entity-graph.service';
import { ImpactAnalysisService, ChangeImpactResult } from '../../../src/code-intel/impact-analysis.service';
import { MemoryItem } from '../../../src/memory/memory-item-repository';
import { HybridSearchResult } from '../../../src/rag/dto/hybrid-search.dto';
import { EntityPath } from '../../../src/entity-graph/dto/entity-graph.types';
import { estimateTokenCount } from '../../../src/context/token-estimator';

describe('ContextBuilderService — AC-7 token budget truncation priority', () => {
  let service: ContextBuilderService;

  const mockCanonicalStateService = { getSnapshot: jest.fn() };
  const mockMemoryItemRepo = { findByProjectMemory: jest.fn() };
  const mockHybridRetriever = { search: jest.fn() };
  const mockEntityGraph = { getRelatedEntities: jest.fn() };
  const mockImpactAnalysis = { getChangeImpact: jest.fn() };
  const mockPrisma = { client: { project: { findUnique: jest.fn() } } };

  const PROJECT_ID = 'p1';
  const TICKET_ID = 't1';
  const REPO_REF = 'r1';

  // Padding values computed so each block hits a target JSON length (and thus token count).
  // estimateTokenCount(s) = Math.ceil(s.length / 4).
  //
  // semanticMemory array JSON base (one item, empty `object` field) = ~199 chars
  //   → pad object with 201 'x' chars → total 400 chars → 100 tokens
  //
  // documents JSON base (one result item, empty `content` field) = ~288 chars
  //   → pad content with 112 'x' chars → total 400 chars → 100 tokens
  //
  // codeIntel array JSON base (one item, empty `commitHash`) = ~117 chars
  //   → pad commitHash with 123 'a' chars → total 240 chars → 60 tokens
  //
  // graphPaths array JSON base (one item, empty `relation`) = ~37 chars
  //   → pad relation with 203 'x' chars → total 240 chars → 60 tokens

  const semanticMemory: MemoryItem[] = [
    {
      id: 'm1',
      projectId: PROJECT_ID,
      kind: 'FACT',
      subject: 's',
      predicate: 'p',
      object: 'x'.repeat(201),
      status: 'active',
      confidence: 0.9,
      createdAt: new Date('2025-01-01T00:00:00.000Z'),
      updatedAt: new Date('2025-01-01T00:00:00.000Z'),
    },
  ];

  const documents: HybridSearchResult = {
    results: [
      {
        id: 'd1',
        source: 'ticket',
        sourceId: 's1',
        content: 'x'.repeat(112),
        score: 0.9,
        similarity: 'high',
        metadata: {},
        createdAt: '2025-01-01T00:00:00.000Z',
        provenance: {
          indexedAt: '2025-01-01T00:00:00.000Z',
          sourceProjectId: PROJECT_ID,
        },
      },
    ],
    scores: [],
    retrievedAt: '2025-01-01T00:00:00.000Z',
  };

  const codeIntelItem: ChangeImpactResult = {
    commitHash: 'a'.repeat(123),
    changedFiles: [],
    impactedSymbols: [],
    impactedServices: [],
    impactedTickets: [],
    impactScore: 0,
  };

  const graphPath: EntityPath = {
    path: [],
    relation: 'x'.repeat(203),
    depth: 2,
  };

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ContextBuilderService,
        { provide: CanonicalStateService, useValue: mockCanonicalStateService },
        { provide: PrismaMemoryItemRepository, useValue: mockMemoryItemRepo },
        { provide: HybridRetrieverService, useValue: mockHybridRetriever },
        { provide: EntityGraphService, useValue: mockEntityGraph },
        { provide: ImpactAnalysisService, useValue: mockImpactAnalysis },
        { provide: PrismaService, useValue: mockPrisma },
      ],
    }).compile();

    service = module.get(ContextBuilderService);

    mockPrisma.client.project.findUnique.mockResolvedValue({ id: PROJECT_ID, deletedAt: null });
    mockCanonicalStateService.getSnapshot.mockResolvedValue({
      tickets: [],
      recentEvents: [],
      activeDecisions: [],
      retrievedAt: new Date(),
    });
    mockMemoryItemRepo.findByProjectMemory.mockResolvedValue({ items: semanticMemory, total: 1 });
    mockHybridRetriever.search.mockResolvedValue(documents);
    mockEntityGraph.getRelatedEntities.mockResolvedValue([graphPath]);
    mockImpactAnalysis.getChangeImpact.mockResolvedValue(codeIntelItem);
  });

  it('removes codeIntel (lowest priority) before graphPaths when codeIntel alone causes the budget overrun', async () => {
    const BUDGET = 275;

    // Verify the test scenario is set up as intended
    const semTokens = estimateTokenCount(JSON.stringify(semanticMemory));
    const docTokens = estimateTokenCount(JSON.stringify(documents));
    const codeIntelTokens = estimateTokenCount(JSON.stringify([codeIntelItem]));
    const graphTokens = estimateTokenCount(JSON.stringify([graphPath]));

    // All four blocks together exceed the budget (320 > 275)
    expect(semTokens + docTokens + codeIntelTokens + graphTokens).toBeGreaterThan(BUDGET);
    // Removing only codeIntel is sufficient to fit within budget (260 <= 275)
    expect(semTokens + docTokens + graphTokens).toBeLessThanOrEqual(BUDGET);
    // codeIntel alone does not cause the overrun — both together are needed to see the bug
    expect(semTokens + docTokens + codeIntelTokens).toBeLessThanOrEqual(BUDGET);

    const query: GetProjectContextQuery = {
      projectId: PROJECT_ID,
      actorId: 'actor-1',
      intent: 'answer',
      query: 'test query',
      tokenBudget: BUDGET,
      includeGraph: true,
      ticketIds: [TICKET_ID],
      includeCodeIntel: true,
      repoRefs: [REPO_REF],
    };

    const result = await service.getProjectContext(query);

    // AC-7 spec: codeIntel has the lowest priority and must be removed first.
    // With budget=275 and total tokens=320, removing codeIntel (60 tokens) alone is sufficient
    // to bring the total to 260 which fits within the budget.
    // Therefore, codeIntel must be undefined and graphPaths must be preserved.
    expect(result.retrievedContext.codeIntel).toBeUndefined();
    expect(result.retrievedContext.graphPaths).toBeDefined();
    expect(result.retrievedContext.graphPaths).toHaveLength(1);
  });

  it('fetches code intel when repoRefs are provided and includeCodeIntel is not set', async () => {
    const query: GetProjectContextQuery = {
      projectId: PROJECT_ID,
      actorId: 'actor-1',
      intent: 'answer',
      query: 'test query',
      tokenBudget: 10000,
      repoRefs: [REPO_REF],
      // includeCodeIntel intentionally omitted — repoRefs alone should trigger code intel
    };

    const result = await service.getProjectContext(query);

    expect(mockImpactAnalysis.getChangeImpact).toHaveBeenCalledTimes(1);
    expect(result.retrievedContext.codeIntel).toBeDefined();
    expect(result.retrievedContext.codeIntel).toHaveLength(1);
  });

  it('does not fetch code intel when includeCodeIntel is explicitly false even with repoRefs', async () => {
    const query: GetProjectContextQuery = {
      projectId: PROJECT_ID,
      actorId: 'actor-1',
      intent: 'answer',
      query: 'test query',
      tokenBudget: 10000,
      repoRefs: [REPO_REF],
      includeCodeIntel: false,
    };

    await service.getProjectContext(query);

    expect(mockImpactAnalysis.getChangeImpact).not.toHaveBeenCalled();
  });
});
