import { createMock } from '@golevelup/ts-jest';
import { ImpactAnalysisService, ChangeImpactQuery, ChangeImpactResult } from './impact-analysis.service';
import { SymbolStore, SymbolData } from './symbol-store';
import { EntityGraphService } from '../entity-graph/entity-graph.service';
import { GraphStoreService } from '../rag/graph-store.service';
import { ICodeIntelRepository, SymbolRow, GraphNodeRow, EntityNodeRow, EntityLinkRow } from './domain/code-intel.domain';
import { EntityNodeType, EntityRecord, EntityPath } from '../entity-graph/dto/entity-graph.types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeQuery(overrides: Partial<ChangeImpactQuery> = {}): ChangeImpactQuery {
  return {
    projectId: 'proj-1',
    repoId: 'repo-1',
    commitHash: 'abc123',
    changedFiles: ['src/a.ts'],
    ...overrides,
  };
}

function makeSymbolRow(overrides: Partial<SymbolRow> = {}): SymbolRow {
  return {
    id: 'repo-1:src/a.ts::Foo',
    symbolId: 'repo-1:src/a.ts::Foo',
    projectId: 'proj-1',
    repoId: 'repo-1',
    commitHash: 'abc123',
    name: 'Foo',
    kind: 'function',
    file: 'src/a.ts',
    startLine: 1,
    endLine: 5,
    signature: null,
    callers: [],
    callees: [],
    docComment: null,
    ...overrides,
  };
}

function makeEntityRecord(
  id: string,
  type: EntityNodeType = EntityNodeType.SERVICE,
): EntityRecord {
  return {
    entityId: id,
    entityType: type,
    label: id,
    metadata: {},
  };
}

function makeEntityNodeRow(entityId: string, entityType: string): EntityNodeRow {
  return { entityId, entityType, label: entityId, metadata: '{}' };
}

function makeGraphNodeRow(nodeId: string, sourceFile: string | null = 'src/a.ts'): GraphNodeRow {
  return { nodeId, label: nodeId, sourceFile, community: null };
}

function makeEntityLinkRow(sourceId: string, targetId: string): EntityLinkRow {
  return { sourceId, targetId, relation: 'ticket_to_service' };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ImpactAnalysisService', () => {
  let service: ImpactAnalysisService;
  let symbolStore: jest.Mocked<SymbolStore>;
  let entityGraph: jest.Mocked<EntityGraphService>;
  let graphStore: jest.Mocked<GraphStoreService>;
  let codeIntelRepo: jest.Mocked<ICodeIntelRepository>;

  beforeEach(() => {
    symbolStore = createMock<SymbolStore>();
    entityGraph = createMock<EntityGraphService>();
    graphStore = createMock<GraphStoreService>();
    codeIntelRepo = {
      findSymbolsByFiles: jest.fn(),
      findGraphNodesByType: jest.fn(),
      findEntityNodesByIds: jest.fn(),
      findEntityLinksByTargetIds: jest.fn(),
      findEntityNodesByIdsAndType: jest.fn(),
      countSymbols: jest.fn(),
      countEntityNodesByTypes: jest.fn(),
      countEntityNodesByType: jest.fn(),
    };

    service = new ImpactAnalysisService(symbolStore, entityGraph, graphStore, codeIntelRepo);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // getChangeImpact — no repository (optional dep absent)
  // -------------------------------------------------------------------------

  describe('when codeIntelRepository is not provided', () => {
    beforeEach(() => {
      service = new ImpactAnalysisService(symbolStore, entityGraph, graphStore);
    });

    it('returns empty impactedSymbols/services/tickets with score 0', async () => {
      const result = await service.getChangeImpact(makeQuery());

      expect(result.commitHash).toBe('abc123');
      expect(result.changedFiles).toEqual(['src/a.ts']);
      expect(result.impactedSymbols).toHaveLength(0);
      expect(result.impactedServices).toHaveLength(0);
      expect(result.impactedTickets).toHaveLength(0);
      expect(result.impactScore).toBe(0);
    });

    it('does not set provenance when ticketId is absent', async () => {
      const result = await service.getChangeImpact(makeQuery());
      expect(result.provenance).toBeUndefined();
    });

    it('sets provenance with empty sources when ticketId is provided but no symbols', async () => {
      const result = await service.getChangeImpact(makeQuery({ ticketId: 'ticket-1' }));
      expect(result.provenance).toBeDefined();
      expect(result.provenance?.ticketId).toBe('ticket-1');
      expect(result.provenance?.sources).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // getChangeImpact — happy path with repository
  // -------------------------------------------------------------------------

  describe('getChangeImpact() — happy path', () => {
    it('returns impacted symbols mapped from repository rows', async () => {
      const row = makeSymbolRow();
      codeIntelRepo.findSymbolsByFiles.mockResolvedValue([row]);
      codeIntelRepo.findGraphNodesByType.mockResolvedValue([]);
      entityGraph.getRelatedEntities.mockResolvedValue([]);
      codeIntelRepo.countSymbols.mockResolvedValue(10);
      codeIntelRepo.countEntityNodesByTypes.mockResolvedValue(5);
      codeIntelRepo.countEntityNodesByType.mockResolvedValue(3);

      const result = await service.getChangeImpact(makeQuery());

      expect(result.impactedSymbols).toHaveLength(1);
      expect(result.impactedSymbols[0].name).toBe('Foo');
      expect(result.impactedSymbols[0].projectId).toBe('proj-1');
    });

    it('maps nullable signature and docComment to undefined', async () => {
      const row = makeSymbolRow({ signature: null, docComment: null });
      codeIntelRepo.findSymbolsByFiles.mockResolvedValue([row]);
      codeIntelRepo.findGraphNodesByType.mockResolvedValue([]);
      entityGraph.getRelatedEntities.mockResolvedValue([]);
      codeIntelRepo.countSymbols.mockResolvedValue(1);
      codeIntelRepo.countEntityNodesByTypes.mockResolvedValue(1);
      codeIntelRepo.countEntityNodesByType.mockResolvedValue(1);

      const result = await service.getChangeImpact(makeQuery());

      expect(result.impactedSymbols[0].signature).toBeUndefined();
      expect(result.impactedSymbols[0].docComment).toBeUndefined();
    });

    it('returns impacted services from graph nodes matching changed files', async () => {
      const row = makeSymbolRow();
      const graphNode = makeGraphNodeRow('svc-node', 'src/a.ts');
      const entityNodeRow = makeEntityNodeRow('service:svc-node', EntityNodeType.SERVICE);

      codeIntelRepo.findSymbolsByFiles.mockResolvedValue([row]);
      codeIntelRepo.findGraphNodesByType.mockResolvedValue([graphNode]);
      codeIntelRepo.findEntityNodesByIds.mockResolvedValue([entityNodeRow]);
      entityGraph.getRelatedEntities.mockResolvedValue([]);
      codeIntelRepo.findEntityLinksByTargetIds.mockResolvedValue([]);
      codeIntelRepo.countSymbols.mockResolvedValue(10);
      codeIntelRepo.countEntityNodesByTypes.mockResolvedValue(5);
      codeIntelRepo.countEntityNodesByType.mockResolvedValue(3);

      const result = await service.getChangeImpact(makeQuery());

      expect(result.impactedServices.length).toBeGreaterThan(0);
      expect(result.impactedServices[0].entityId).toBe('service:svc-node');
    });

    it('includes services discovered via entityGraph.getRelatedEntities', async () => {
      const row = makeSymbolRow();
      const relatedService = makeEntityRecord('svc-via-graph', EntityNodeType.SERVICE);
      const entityPath: EntityPath = {
        path: [relatedService],
        relation: 'uses',
        depth: 1,
      };

      codeIntelRepo.findSymbolsByFiles.mockResolvedValue([row]);
      codeIntelRepo.findGraphNodesByType.mockResolvedValue([]);
      entityGraph.getRelatedEntities.mockResolvedValue([entityPath]);
      codeIntelRepo.findEntityLinksByTargetIds.mockResolvedValue([]);
      codeIntelRepo.countSymbols.mockResolvedValue(10);
      codeIntelRepo.countEntityNodesByTypes.mockResolvedValue(5);
      codeIntelRepo.countEntityNodesByType.mockResolvedValue(3);

      const result = await service.getChangeImpact(makeQuery());

      expect(result.impactedServices.some((s) => s.entityId === 'svc-via-graph')).toBe(true);
    });

    it('deduplicates services found via both graph nodes and entityGraph', async () => {
      const row = makeSymbolRow();
      const graphNode = makeGraphNodeRow('svc-node', 'src/a.ts');
      const entityNodeRow = makeEntityNodeRow('service:svc-node', EntityNodeType.SERVICE);
      const relatedService = makeEntityRecord('service:svc-node', EntityNodeType.SERVICE);
      const entityPath: EntityPath = { path: [relatedService], relation: 'uses', depth: 1 };

      codeIntelRepo.findSymbolsByFiles.mockResolvedValue([row]);
      codeIntelRepo.findGraphNodesByType.mockResolvedValue([graphNode]);
      codeIntelRepo.findEntityNodesByIds.mockResolvedValue([entityNodeRow]);
      entityGraph.getRelatedEntities.mockResolvedValue([entityPath]);
      codeIntelRepo.findEntityLinksByTargetIds.mockResolvedValue([]);
      codeIntelRepo.countSymbols.mockResolvedValue(10);
      codeIntelRepo.countEntityNodesByTypes.mockResolvedValue(5);
      codeIntelRepo.countEntityNodesByType.mockResolvedValue(3);

      const result = await service.getChangeImpact(makeQuery());

      const ids = result.impactedServices.map((s) => s.entityId);
      const unique = new Set(ids);
      expect(ids.length).toBe(unique.size);
    });

    it('returns impacted tickets linked to impacted services', async () => {
      const row = makeSymbolRow();
      const relatedService = makeEntityRecord('svc-1', EntityNodeType.SERVICE);
      const entityPath: EntityPath = { path: [relatedService], relation: 'uses', depth: 1 };
      const ticketLink = makeEntityLinkRow('ticket-entity-1', 'svc-1');
      const ticketNodeRow = makeEntityNodeRow('ticket-entity-1', EntityNodeType.TICKET);

      codeIntelRepo.findSymbolsByFiles.mockResolvedValue([row]);
      codeIntelRepo.findGraphNodesByType.mockResolvedValue([]);
      entityGraph.getRelatedEntities
        .mockResolvedValueOnce([entityPath])  // for symbol -> services
        .mockResolvedValue([]);               // for service -> tickets
      codeIntelRepo.findEntityLinksByTargetIds.mockResolvedValue([ticketLink]);
      codeIntelRepo.findEntityNodesByIdsAndType.mockResolvedValue([ticketNodeRow]);
      codeIntelRepo.countSymbols.mockResolvedValue(10);
      codeIntelRepo.countEntityNodesByTypes.mockResolvedValue(5);
      codeIntelRepo.countEntityNodesByType.mockResolvedValue(3);

      const result = await service.getChangeImpact(makeQuery());

      expect(result.impactedTickets.some((t) => t.entityId === 'ticket-entity-1')).toBe(true);
    });

    it('includes provenance with sources when ticketId is set', async () => {
      const row = makeSymbolRow({ name: 'MyFn' });
      codeIntelRepo.findSymbolsByFiles.mockResolvedValue([row]);
      codeIntelRepo.findGraphNodesByType.mockResolvedValue([]);
      entityGraph.getRelatedEntities.mockResolvedValue([]);
      codeIntelRepo.findEntityLinksByTargetIds.mockResolvedValue([]);
      codeIntelRepo.countSymbols.mockResolvedValue(10);
      codeIntelRepo.countEntityNodesByTypes.mockResolvedValue(5);
      codeIntelRepo.countEntityNodesByType.mockResolvedValue(3);

      const result = await service.getChangeImpact(makeQuery({ ticketId: 'ticket-42' }));

      expect(result.provenance).toBeDefined();
      expect(result.provenance?.ticketId).toBe('ticket-42');
      expect(result.provenance?.sources).toContain('MyFn');
    });
  });

  // -------------------------------------------------------------------------
  // calculateImpactScore
  // -------------------------------------------------------------------------

  describe('impact score calculation', () => {
    it('returns 0 when no symbols, services, or tickets are impacted', async () => {
      codeIntelRepo.findSymbolsByFiles.mockResolvedValue([]);
      // With no symbols -> getImpactedServices returns early [] -> getImpactedTickets returns early []
      codeIntelRepo.countSymbols.mockResolvedValue(10);
      codeIntelRepo.countEntityNodesByTypes.mockResolvedValue(5);
      codeIntelRepo.countEntityNodesByType.mockResolvedValue(3);

      const result = await service.getChangeImpact(makeQuery());

      expect(result.impactScore).toBe(0);
    });

    it('returns a positive score proportional to the fraction of impacted symbols', async () => {
      const rows = [makeSymbolRow(), makeSymbolRow({ id: 'b', symbolId: 'b', name: 'Bar' })];
      codeIntelRepo.findSymbolsByFiles.mockResolvedValue(rows);
      codeIntelRepo.findGraphNodesByType.mockResolvedValue([]);
      entityGraph.getRelatedEntities.mockResolvedValue([]);
      codeIntelRepo.findEntityLinksByTargetIds.mockResolvedValue([]);
      // 2 out of 10 symbols impacted -> symbolTerm = 20
      codeIntelRepo.countSymbols.mockResolvedValue(10);
      codeIntelRepo.countEntityNodesByTypes.mockResolvedValue(10);
      codeIntelRepo.countEntityNodesByType.mockResolvedValue(10);

      const result = await service.getChangeImpact(makeQuery());

      // score = 0.3*(2/10*100) + 0.3*(0/10*100) + ... >= 6
      expect(result.impactScore).toBeGreaterThan(0);
      expect(result.impactScore).toBeLessThanOrEqual(100);
    });

    it('clamps score between 0 and 100', async () => {
      const rows = Array.from({ length: 200 }, (_, i) =>
        makeSymbolRow({ id: String(i), symbolId: String(i), name: `Sym${i}` }),
      );
      codeIntelRepo.findSymbolsByFiles.mockResolvedValue(rows);
      codeIntelRepo.findGraphNodesByType.mockResolvedValue([]);
      entityGraph.getRelatedEntities.mockResolvedValue([]);
      codeIntelRepo.findEntityLinksByTargetIds.mockResolvedValue([]);
      codeIntelRepo.countSymbols.mockResolvedValue(1);
      codeIntelRepo.countEntityNodesByTypes.mockResolvedValue(1);
      codeIntelRepo.countEntityNodesByType.mockResolvedValue(1);

      const result = await service.getChangeImpact(makeQuery());

      expect(result.impactScore).toBeLessThanOrEqual(100);
      expect(result.impactScore).toBeGreaterThanOrEqual(0);
    });
  });

  // -------------------------------------------------------------------------
  // Error resilience
  // -------------------------------------------------------------------------

  describe('error resilience', () => {
    it('continues gracefully when entityGraph.getRelatedEntities throws for a symbol', async () => {
      const row = makeSymbolRow();
      codeIntelRepo.findSymbolsByFiles.mockResolvedValue([row]);
      codeIntelRepo.findGraphNodesByType.mockResolvedValue([]);
      entityGraph.getRelatedEntities.mockRejectedValue(new Error('graph unavailable'));
      codeIntelRepo.findEntityLinksByTargetIds.mockResolvedValue([]);
      codeIntelRepo.countSymbols.mockResolvedValue(10);
      codeIntelRepo.countEntityNodesByTypes.mockResolvedValue(5);
      codeIntelRepo.countEntityNodesByType.mockResolvedValue(3);

      // Should not throw
      const result = await service.getChangeImpact(makeQuery());

      expect(result.impactedSymbols).toHaveLength(1);
      // Services derived from failing entityGraph call are silently skipped
    });

    it('handles malformed metadata JSON gracefully', async () => {
      const row = makeSymbolRow();
      const graphNode = makeGraphNodeRow('svc-node', 'src/a.ts');
      const entityNodeRow: EntityNodeRow = {
        entityId: 'service:svc-node',
        entityType: EntityNodeType.SERVICE,
        label: 'svc-node',
        metadata: 'not-json',
      };

      codeIntelRepo.findSymbolsByFiles.mockResolvedValue([row]);
      codeIntelRepo.findGraphNodesByType.mockResolvedValue([graphNode]);
      codeIntelRepo.findEntityNodesByIds.mockResolvedValue([entityNodeRow]);
      entityGraph.getRelatedEntities.mockResolvedValue([]);
      codeIntelRepo.findEntityLinksByTargetIds.mockResolvedValue([]);
      codeIntelRepo.countSymbols.mockResolvedValue(10);
      codeIntelRepo.countEntityNodesByTypes.mockResolvedValue(5);
      codeIntelRepo.countEntityNodesByType.mockResolvedValue(3);

      // parseMetadata should fall back to {} without throwing
      const result = await service.getChangeImpact(makeQuery());

      expect(result.impactedServices[0].metadata).toEqual({});
    });
  });

  // -------------------------------------------------------------------------
  // Empty / edge cases
  // -------------------------------------------------------------------------

  describe('edge cases', () => {
    it('returns empty services when no symbols are found', async () => {
      codeIntelRepo.findSymbolsByFiles.mockResolvedValue([]);
      codeIntelRepo.countSymbols.mockResolvedValue(10);
      codeIntelRepo.countEntityNodesByTypes.mockResolvedValue(5);
      codeIntelRepo.countEntityNodesByType.mockResolvedValue(3);

      const result = await service.getChangeImpact(makeQuery());

      expect(result.impactedServices).toHaveLength(0);
      expect(entityGraph.getRelatedEntities).not.toHaveBeenCalled();
    });

    it('returns empty tickets when no services are found', async () => {
      codeIntelRepo.findSymbolsByFiles.mockResolvedValue([]);
      codeIntelRepo.countSymbols.mockResolvedValue(10);
      codeIntelRepo.countEntityNodesByTypes.mockResolvedValue(5);
      codeIntelRepo.countEntityNodesByType.mockResolvedValue(3);

      const result = await service.getChangeImpact(makeQuery());

      expect(result.impactedTickets).toHaveLength(0);
    });

    it('does not include provenance when ticketId is absent', async () => {
      codeIntelRepo.findSymbolsByFiles.mockResolvedValue([]);
      codeIntelRepo.countSymbols.mockResolvedValue(10);
      codeIntelRepo.countEntityNodesByTypes.mockResolvedValue(5);
      codeIntelRepo.countEntityNodesByType.mockResolvedValue(3);

      const result = await service.getChangeImpact(makeQuery({ ticketId: undefined }));

      expect(result.provenance).toBeUndefined();
    });

    it('uses Math.max(1, count) so zero counts do not cause division-by-zero', async () => {
      const row = makeSymbolRow();
      codeIntelRepo.findSymbolsByFiles.mockResolvedValue([row]);
      codeIntelRepo.findGraphNodesByType.mockResolvedValue([]);
      entityGraph.getRelatedEntities.mockResolvedValue([]);
      codeIntelRepo.findEntityLinksByTargetIds.mockResolvedValue([]);
      codeIntelRepo.countSymbols.mockResolvedValue(0);
      codeIntelRepo.countEntityNodesByTypes.mockResolvedValue(0);
      codeIntelRepo.countEntityNodesByType.mockResolvedValue(0);

      // Should not throw and should produce a valid score
      const result = await service.getChangeImpact(makeQuery());

      expect(result.impactScore).toBeGreaterThanOrEqual(0);
      expect(result.impactScore).toBeLessThanOrEqual(100);
    });
  });
});
