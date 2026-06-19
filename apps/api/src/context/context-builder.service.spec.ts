import { Test, TestingModule } from '@nestjs/testing';
import { createMock } from '@golevelup/ts-jest';
import { InternalAppException } from '@nathapp/nestjs-common';
import { ContextBuilderService, GetProjectContextQuery, ProjectNotFoundError } from './context-builder.service';
import { CanonicalStateService, CanonicalTicket, CanonicalEvent, CanonicalDecision } from '../memory/canonical-state.service';
import { PrismaMemoryItemRepository } from '../memory/prisma-memory-item.repository';
import { HybridRetrieverService } from '../rag/hybrid-retriever.service';
import { HybridSearchResult, HybridSearchResultItem, ScoreBreakdown } from '../rag/dto/hybrid-search.dto';
import { EntityGraphService } from '../entity-graph/entity-graph.service';
import { ImpactAnalysisService, ChangeImpactResult } from '../code-intel/impact-analysis.service';
import { SloDashboardService } from '../monitoring/slo-dashboard.service';
import { CONTEXT_REPOSITORY, IContextRepository } from './domain/context.domain';
import { MemoryItem } from '../memory/memory-item-repository';

const makeEvent = (overrides?: Partial<CanonicalEvent>): CanonicalEvent => ({
  id: 'event-1',
  eventType: 'TICKET_CREATED',
  actorId: 'user-1',
  action: 'create',
  rationale: null,
  createdAt: new Date('2024-01-01T00:00:00Z'),
  payload: {},
  ...overrides,
});

const makeTicket = (overrides?: Partial<CanonicalTicket>): CanonicalTicket => ({
  id: 'ticket-1',
  title: 'Test Ticket',
  status: 'OPEN',
  priority: 'MEDIUM',
  assignedToUserId: null,
  assignedToAgentId: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...overrides,
});

const makeDecision = (overrides?: Partial<CanonicalDecision>): CanonicalDecision => ({
  id: 'decision-1',
  topic: 'Database choice',
  decision: 'Use PostgreSQL',
  rationale: 'Better performance',
  createdAt: new Date(),
  ...overrides,
});

const makeResultItem = (overrides?: Partial<HybridSearchResultItem>): HybridSearchResultItem => ({
  id: 'doc-1',
  source: 'ticket',
  sourceId: 'ticket-1',
  content: 'test content',
  score: 0.9,
  similarity: 'high',
  metadata: {},
  createdAt: new Date().toISOString(),
  provenance: { indexedAt: new Date().toISOString(), sourceProjectId: 'project-1' },
  ...overrides,
});

const makeScoreBreakdown = (): ScoreBreakdown => ({
  vectorScore: 0.9,
  lexicalScore: 0.8,
  entityScore: 0.7,
  recencyScore: 0.6,
  finalScore: 0.9,
});

const makeMemoryItem = (overrides?: Partial<MemoryItem>): MemoryItem => ({
  id: 'mem-1',
  projectId: 'project-1',
  kind: 'fact',
  subject: 'auth',
  predicate: 'uses',
  status: 'active',
  confidence: 0.9,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...overrides,
});

const makeImpactResult = (overrides?: Partial<ChangeImpactResult>): ChangeImpactResult => ({
  commitHash: 'sha-abc',
  changedFiles: [],
  impactedSymbols: [],
  impactedServices: [],
  impactedTickets: [],
  impactScore: 0,
  ...overrides,
});

const emptyDocuments: HybridSearchResult = {
  results: [],
  scores: [],
  retrievedAt: new Date().toISOString(),
};

const baseQuery: GetProjectContextQuery = {
  projectId: 'project-1',
  actorId: 'actor-1',
  intent: 'answer',
};

describe('ContextBuilderService', () => {
  let service: ContextBuilderService;
  let contextRepository: jest.Mocked<IContextRepository>;
  let canonicalStateService: jest.Mocked<CanonicalStateService>;
  let memoryItemRepository: jest.Mocked<PrismaMemoryItemRepository>;
  let hybridRetrieverService: jest.Mocked<HybridRetrieverService>;
  let entityGraphService: jest.Mocked<EntityGraphService>;
  let impactAnalysisService: jest.Mocked<ImpactAnalysisService>;
  let sloDashboardService: jest.Mocked<SloDashboardService>;

  const setupDefaultStubs = () => {
    contextRepository.projectExistsAndNotDeleted.mockResolvedValue(true);
    canonicalStateService.getSnapshot.mockResolvedValue({
      tickets: [],
      recentEvents: [],
      activeDecisions: [],
      retrievedAt: new Date(),
    });
    memoryItemRepository.findByProjectMemory.mockResolvedValue({ items: [], total: 0 });
    hybridRetrieverService.search.mockResolvedValue(emptyDocuments);
  };

  beforeEach(async () => {
    contextRepository = createMock<IContextRepository>();
    canonicalStateService = createMock<CanonicalStateService>();
    memoryItemRepository = createMock<PrismaMemoryItemRepository>();
    hybridRetrieverService = createMock<HybridRetrieverService>();
    entityGraphService = createMock<EntityGraphService>();
    impactAnalysisService = createMock<ImpactAnalysisService>();
    sloDashboardService = createMock<SloDashboardService>();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ContextBuilderService,
        { provide: CONTEXT_REPOSITORY, useValue: contextRepository },
        { provide: CanonicalStateService, useValue: canonicalStateService },
        { provide: PrismaMemoryItemRepository, useValue: memoryItemRepository },
        { provide: HybridRetrieverService, useValue: hybridRetrieverService },
        { provide: EntityGraphService, useValue: entityGraphService },
        { provide: ImpactAnalysisService, useValue: impactAnalysisService },
        { provide: SloDashboardService, useValue: sloDashboardService },
      ],
    }).compile();

    service = module.get(ContextBuilderService);
    jest.clearAllMocks();
  });

  describe('project existence check', () => {
    test('throws ProjectNotFoundError when project does not exist', async () => {
      contextRepository.projectExistsAndNotDeleted.mockResolvedValue(false);

      await expect(service.getProjectContext(baseQuery)).rejects.toThrow(ProjectNotFoundError);
    });

    test('throws ProjectNotFoundError when project is soft-deleted', async () => {
      contextRepository.projectExistsAndNotDeleted.mockResolvedValue(false);

      await expect(service.getProjectContext({ ...baseQuery, projectId: 'deleted-project' })).rejects.toThrow(ProjectNotFoundError);
    });

    test('does not throw when project exists and is not deleted', async () => {
      setupDefaultStubs();

      await expect(service.getProjectContext(baseQuery)).resolves.toBeDefined();
    });
  });

  describe('response shape', () => {
    test('returns correct projectId in response', async () => {
      setupDefaultStubs();

      const result = await service.getProjectContext(baseQuery);

      expect(result.projectId).toBe('project-1');
    });

    test('includes meta with intent, tokensUsed, retrievedAt, and latencyMs', async () => {
      setupDefaultStubs();

      const result = await service.getProjectContext(baseQuery);

      expect(result.meta.intent).toBe('answer');
      expect(typeof result.meta.tokensUsed).toBe('number');
      expect(result.meta.retrievedAt).toBeInstanceOf(Date);
      expect(typeof result.meta.latencyMs).toBe('number');
    });

    test('returns latencyMs as a positive integer', async () => {
      setupDefaultStubs();

      const result = await service.getProjectContext(baseQuery);

      expect(result.meta.latencyMs).toBeGreaterThanOrEqual(0);
      expect(Number.isInteger(result.meta.latencyMs)).toBe(true);
    });

    test('returns provenance with retrievalStrategy canonical-only when no query provided', async () => {
      setupDefaultStubs();

      const result = await service.getProjectContext(baseQuery);

      expect(result.provenance.retrievalStrategy).toBe('canonical-only');
    });

    test('returns provenance with retrievalStrategy hybrid when query is provided', async () => {
      setupDefaultStubs();

      const result = await service.getProjectContext({ ...baseQuery, query: 'how does auth work?' });

      expect(result.provenance.retrievalStrategy).toBe('hybrid');
    });

    test('returns provenance sources mapped from document results', async () => {
      setupDefaultStubs();
      hybridRetrieverService.search.mockResolvedValue({
        results: [makeResultItem({ source: 'ticket', sourceId: 'ticket-1', score: 0.9 })],
        scores: [makeScoreBreakdown()],
        retrievedAt: new Date().toISOString(),
      });

      const result = await service.getProjectContext({ ...baseQuery, query: 'auth' });

      expect(result.provenance.sources).toHaveLength(1);
      expect(result.provenance.sources[0]).toMatchObject({ sourceType: 'ticket', sourceId: 'ticket-1', score: 0.9 });
    });
  });

  describe('canonical state', () => {
    test('passes ticketIds to canonicalStateService.getSnapshot', async () => {
      setupDefaultStubs();

      await service.getProjectContext({ ...baseQuery, ticketIds: ['ticket-1', 'ticket-2'] });

      expect(canonicalStateService.getSnapshot).toHaveBeenCalledWith(
        expect.objectContaining({ ticketIds: ['ticket-1', 'ticket-2'] }),
      );
    });

    test('includes tickets from canonical snapshot in response', async () => {
      setupDefaultStubs();
      const ticket = makeTicket();
      canonicalStateService.getSnapshot.mockResolvedValue({
        tickets: [ticket],
        recentEvents: [],
        activeDecisions: [],
        retrievedAt: new Date(),
      });

      const result = await service.getProjectContext(baseQuery);

      expect(result.canonicalState.tickets).toContainEqual(expect.objectContaining({ id: 'ticket-1' }));
    });

    test('includes active decisions from canonical snapshot', async () => {
      setupDefaultStubs();
      const decision = makeDecision();
      canonicalStateService.getSnapshot.mockResolvedValue({
        tickets: [],
        recentEvents: [],
        activeDecisions: [decision],
        retrievedAt: new Date(),
      });

      const result = await service.getProjectContext(baseQuery);

      expect(result.canonicalState.activeDecisions).toContainEqual(expect.objectContaining({ id: 'decision-1' }));
    });
  });

  describe('recent events', () => {
    test('returns recent events sorted descending by createdAt for answer intent', async () => {
      setupDefaultStubs();
      const older = makeEvent({ id: 'event-old', createdAt: new Date('2024-01-01') });
      const newer = makeEvent({ id: 'event-new', createdAt: new Date('2024-06-01') });
      canonicalStateService.getSnapshot.mockResolvedValue({
        tickets: [],
        recentEvents: [older, newer],
        activeDecisions: [],
        retrievedAt: new Date(),
      });

      const result = await service.getProjectContext(baseQuery);

      expect(result.canonicalState.recentEvents![0].id).toBe('event-new');
      expect(result.canonicalState.recentEvents![1].id).toBe('event-old');
    });

    test('returns undefined recentEvents for plan intent', async () => {
      setupDefaultStubs();
      canonicalStateService.getSnapshot.mockResolvedValue({
        tickets: [],
        recentEvents: [makeEvent()],
        activeDecisions: [],
        retrievedAt: new Date(),
      });

      const result = await service.getProjectContext({ ...baseQuery, intent: 'plan' });

      expect(result.canonicalState.recentEvents).toBeUndefined();
    });

    test('truncates recent events to 20 for non-plan intents', async () => {
      setupDefaultStubs();
      const events = Array.from({ length: 25 }, (_, i) =>
        makeEvent({ id: `event-${i}`, createdAt: new Date(Date.now() + i * 1000) }),
      );
      canonicalStateService.getSnapshot.mockResolvedValue({
        tickets: [],
        recentEvents: events,
        activeDecisions: [],
        retrievedAt: new Date(),
      });

      const result = await service.getProjectContext(baseQuery);

      expect(result.canonicalState.recentEvents).toHaveLength(20);
    });
  });

  describe('hybrid document retrieval', () => {
    test('does not call hybridRetrieverService when query is empty', async () => {
      setupDefaultStubs();

      await service.getProjectContext(baseQuery);

      expect(hybridRetrieverService.search).not.toHaveBeenCalled();
    });

    test('does not call hybridRetrieverService when query is whitespace only', async () => {
      setupDefaultStubs();

      await service.getProjectContext({ ...baseQuery, query: '   ' });

      expect(hybridRetrieverService.search).not.toHaveBeenCalled();
    });

    test('calls hybridRetrieverService with correct params when query is provided', async () => {
      setupDefaultStubs();

      await service.getProjectContext({ ...baseQuery, query: 'auth flow' });

      expect(hybridRetrieverService.search).toHaveBeenCalledWith(
        expect.objectContaining({ projectId: 'project-1', query: 'auth flow', intent: 'answer' }),
      );
    });

    test('returns empty documents when hybridRetrieverService throws', async () => {
      setupDefaultStubs();
      hybridRetrieverService.search.mockRejectedValue(new Error('search failed'));

      const result = await service.getProjectContext({ ...baseQuery, query: 'auth' });

      expect(result.retrievedContext.documents.results).toHaveLength(0);
    });
  });

  describe('graph paths', () => {
    test('does not fetch graph paths when includeGraph is false', async () => {
      setupDefaultStubs();

      await service.getProjectContext({ ...baseQuery, includeGraph: false, ticketIds: ['ticket-1'] });

      expect(entityGraphService.getRelatedEntities).not.toHaveBeenCalled();
    });

    test('does not fetch graph paths when ticketIds is empty', async () => {
      setupDefaultStubs();

      await service.getProjectContext({ ...baseQuery, includeGraph: true });

      expect(entityGraphService.getRelatedEntities).not.toHaveBeenCalled();
    });

    test('fetches graph paths for each ticketId when includeGraph is true', async () => {
      setupDefaultStubs();
      entityGraphService.getRelatedEntities.mockResolvedValue([]);

      await service.getProjectContext({ ...baseQuery, includeGraph: true, ticketIds: ['ticket-1', 'ticket-2'] });

      expect(entityGraphService.getRelatedEntities).toHaveBeenCalledTimes(2);
      expect(entityGraphService.getRelatedEntities).toHaveBeenCalledWith('project-1', 'ticket-1', 2);
      expect(entityGraphService.getRelatedEntities).toHaveBeenCalledWith('project-1', 'ticket-2', 2);
    });

    test('returns empty graphPaths when entityGraphService throws', async () => {
      setupDefaultStubs();
      entityGraphService.getRelatedEntities.mockRejectedValue(new Error('graph error'));

      const result = await service.getProjectContext({ ...baseQuery, includeGraph: true, ticketIds: ['ticket-1'] });

      expect(result.retrievedContext.graphPaths).toEqual([]);
    });
  });

  describe('code intel', () => {
    test('does not fetch code intel when repoRefs is empty', async () => {
      setupDefaultStubs();

      await service.getProjectContext({ ...baseQuery, includeCodeIntel: true });

      expect(impactAnalysisService.getChangeImpact).not.toHaveBeenCalled();
    });

    test('fetches code intel for each repoRef when repoRefs is provided', async () => {
      setupDefaultStubs();
      impactAnalysisService.getChangeImpact.mockResolvedValue(makeImpactResult({ commitHash: 'sha-abc' }));

      await service.getProjectContext({ ...baseQuery, repoRefs: ['sha-abc', 'sha-def'] });

      expect(impactAnalysisService.getChangeImpact).toHaveBeenCalledTimes(2);
    });

    test('does not fetch code intel when includeCodeIntel is explicitly false', async () => {
      setupDefaultStubs();

      await service.getProjectContext({ ...baseQuery, includeCodeIntel: false, repoRefs: ['sha-abc'] });

      expect(impactAnalysisService.getChangeImpact).not.toHaveBeenCalled();
    });

    test('returns empty codeIntel array when impactAnalysisService throws', async () => {
      setupDefaultStubs();
      impactAnalysisService.getChangeImpact.mockRejectedValue(new Error('intel error'));

      const result = await service.getProjectContext({ ...baseQuery, repoRefs: ['sha-abc'] });

      expect(result.retrievedContext.codeIntel).toEqual([]);
    });
  });

  describe('token budget enforcement', () => {
    test('uses DEFAULT_TOKEN_BUDGET of 4000 when tokenBudget is not specified', async () => {
      setupDefaultStubs();
      memoryItemRepository.findByProjectMemory.mockResolvedValue({
        items: [makeMemoryItem()],
        total: 1,
      });

      const result = await service.getProjectContext(baseQuery);

      expect(result.meta.tokensUsed).toBeGreaterThan(0);
    });

    test('drops codeIntel first when token budget is exceeded', async () => {
      setupDefaultStubs();
      const bigContent = 'x'.repeat(10000);
      impactAnalysisService.getChangeImpact.mockResolvedValue(
        makeImpactResult({
          commitHash: 'sha-1',
          impactedTickets: [{
            entityId: 'ticket-1',
            entityType: 'ticket' as const,
            label: bigContent,
            metadata: {},
          }],
        }),
      );

      const result = await service.getProjectContext({
        ...baseQuery,
        repoRefs: ['sha-1'],
        tokenBudget: 10,
      });

      expect(result.retrievedContext.codeIntel).toBeUndefined();
    });

    test('drops documents when budget is too small to fit retrieved context', async () => {
      setupDefaultStubs();
      hybridRetrieverService.search.mockResolvedValue({
        results: [makeResultItem({ content: 'x'.repeat(5000) })],
        scores: [makeScoreBreakdown()],
        retrievedAt: new Date().toISOString(),
      });
      memoryItemRepository.findByProjectMemory.mockResolvedValue({
        items: [makeMemoryItem({ subject: 'x'.repeat(5000) })],
        total: 1,
      });

      const result = await service.getProjectContext({
        ...baseQuery,
        query: 'large',
        tokenBudget: 1,
      });

      // with tiny budget retrieved context should be cleared
      expect(result.retrievedContext.documents.results).toHaveLength(0);
    });
  });

  describe('semantic memory', () => {
    test('sorts semantic memory by confidence descending', async () => {
      setupDefaultStubs();
      memoryItemRepository.findByProjectMemory.mockResolvedValue({
        items: [
          makeMemoryItem({ id: 'mem-low', confidence: 0.3 }),
          makeMemoryItem({ id: 'mem-high', confidence: 0.9 }),
        ],
        total: 2,
      });

      const result = await service.getProjectContext(baseQuery);

      expect(result.retrievedContext.semanticMemory[0].id).toBe('mem-high');
      expect(result.retrievedContext.semanticMemory[1].id).toBe('mem-low');
    });
  });

  describe('error handling', () => {
    test('rethrows AppException from canonicalStateService without wrapping', async () => {
      contextRepository.projectExistsAndNotDeleted.mockResolvedValue(true);
      canonicalStateService.getSnapshot.mockRejectedValue(new ProjectNotFoundError());
      memoryItemRepository.findByProjectMemory.mockResolvedValue({ items: [], total: 0 });
      hybridRetrieverService.search.mockResolvedValue(emptyDocuments);

      await expect(service.getProjectContext(baseQuery)).rejects.toThrow(ProjectNotFoundError);
    });

    test('wraps generic errors in InternalAppException', async () => {
      contextRepository.projectExistsAndNotDeleted.mockResolvedValue(true);
      canonicalStateService.getSnapshot.mockRejectedValue(new Error('unexpected'));
      memoryItemRepository.findByProjectMemory.mockResolvedValue({ items: [], total: 0 });
      hybridRetrieverService.search.mockResolvedValue(emptyDocuments);

      await expect(service.getProjectContext(baseQuery)).rejects.toThrow(InternalAppException);
    });
  });
});
