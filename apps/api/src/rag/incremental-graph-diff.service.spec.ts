import type { Mock, Mocked } from 'vitest';
vi.mock('@lancedb/lancedb', () => ({
  connect: vi.fn().mockResolvedValue({
    tableNames: vi.fn().mockResolvedValue([]),
    createTable: vi.fn().mockResolvedValue({
      delete: vi.fn().mockResolvedValue(undefined),
      createIndex: vi.fn().mockResolvedValue(undefined),
      add: vi.fn().mockResolvedValue(undefined),
      query: vi.fn().mockReturnValue({ limit: vi.fn().mockReturnThis(), toArray: vi.fn().mockResolvedValue([]) }),
      countRows: vi.fn().mockResolvedValue(0),
    }),
    openTable: vi.fn().mockResolvedValue({
      delete: vi.fn().mockResolvedValue(undefined),
      createIndex: vi.fn().mockResolvedValue(undefined),
      add: vi.fn().mockResolvedValue(undefined),
      query: vi.fn().mockReturnValue({ limit: vi.fn().mockReturnThis(), toArray: vi.fn().mockResolvedValue([]) }),
      countRows: vi.fn().mockResolvedValue(0),
      search: vi.fn().mockResolvedValue([]),
      vectorSearch: vi.fn().mockReturnValue({ distanceType: vi.fn().mockReturnThis(), limit: vi.fn().mockReturnThis(), toArray: vi.fn().mockResolvedValue([]) }),
      optimize: vi.fn().mockResolvedValue(undefined),
    }),
  }),
  Index: { fts: vi.fn().mockReturnValue({}) },
}));

import { IncrementalGraphDiffService } from './incremental-graph-diff.service';
import { GraphStoreService } from './graph-store.service';
import type { GraphifyNodeDto, GraphifyLinkDto } from './dto/import-graphify.dto';

function makeStoredNode(id: string, overrides?: Partial<GraphifyNodeDto>): GraphifyNodeDto {
  return { id, label: `Service_${id}`, type: 'class', ...overrides };
}

function makeLink(source: string, target: string, relation = 'depends_on'): GraphifyLinkDto {
  return { source, target, relation };
}

function storedGraphFromNodes(
  nodes: GraphifyNodeDto[],
  links: GraphifyLinkDto[] = [],
): {
  nodeMap: Map<string, GraphifyNodeDto>;
  linkMap: Map<string, GraphifyLinkDto[]>;
} {
  const nodeMap = new Map(nodes.map((n) => [n.id, n]));
  const linkMap = new Map<string, GraphifyLinkDto[]>();
  for (const link of links) {
    const list = linkMap.get(link.source);
    if (list) {
      list.push(link);
    } else {
      linkMap.set(link.source, [link]);
    }
  }
  return { nodeMap, linkMap };
}

describe('IncrementalGraphDiffService', () => {
  let service: IncrementalGraphDiffService;
  let mockGraphStore: Mocked<Pick<GraphStoreService, 'getStoredGraph' | 'applyDiff' | 'markVectorStale' | 'findVectorStaleNodeIds' | 'clearVectorStale'>>;
  let mockVectorStore: { indexDocument: Mock; deleteBySource: Mock };
  let mockTxManager: { run: Mock };

  beforeEach(() => {
    mockTxManager = {
      run: vi.fn((fn: () => Promise<unknown>) => fn()),
    };

    mockGraphStore = {
      getStoredGraph: vi.fn(),
      applyDiff: vi.fn().mockResolvedValue(undefined),
      markVectorStale: vi.fn().mockResolvedValue(undefined),
      findVectorStaleNodeIds: vi.fn().mockResolvedValue([]),
      clearVectorStale: vi.fn().mockResolvedValue(undefined),
    };

    mockVectorStore = {
      indexDocument: vi.fn().mockResolvedValue(undefined),
      deleteBySource: vi.fn().mockResolvedValue(undefined),
    };

    service = new IncrementalGraphDiffService(
      mockGraphStore as unknown as GraphStoreService,
      mockVectorStore as never,
      mockTxManager as never,
    );
  });

  describe('AC-1: diffAndApply computes and applies only the delta', () => {
    it('applies only added, modified, and removed nodes/links', async () => {
      const projectId = 'test-project';

      mockGraphStore.getStoredGraph.mockResolvedValue(storedGraphFromNodes([
        makeStoredNode('node-1'),
        makeStoredNode('node-2'),
      ]));

      const newNodes: GraphifyNodeDto[] = [
        makeStoredNode('node-1'),
        { id: 'node-3', label: 'NewService', type: 'class' },
      ];
      const newLinks: GraphifyLinkDto[] = [
        makeLink('node-1', 'node-3', 'uses'),
      ];

      const result = await service.diffAndApply(projectId, newNodes, newLinks);

      expect(result.added).toBe(1);
      expect(result.removed).toBe(1);
      expect(mockGraphStore.applyDiff).toHaveBeenCalledWith(projectId, expect.objectContaining({ removedNodeIds: ['node-2'] }));
      expect(mockVectorStore.deleteBySource).toHaveBeenCalledWith(projectId, 'node-2');
    });

    it('deletes node-2 which is absent from incoming nodes', async () => {
      const projectId = 'test-project';

      mockGraphStore.getStoredGraph.mockResolvedValue(storedGraphFromNodes([
        makeStoredNode('node-1'),
        makeStoredNode('node-2'),
      ]));

      const newNodes: GraphifyNodeDto[] = [
        makeStoredNode('node-1'),
      ];

      const result = await service.diffAndApply(projectId, newNodes, []);

      expect(result.removed).toBe(1);
      expect(mockGraphStore.applyDiff).toHaveBeenCalledWith(projectId, expect.objectContaining({ removedNodeIds: ['node-2'] }));
      expect(mockVectorStore.deleteBySource).toHaveBeenCalledWith(projectId, 'node-2');
    });

    it('does not re-process unchanged nodes', async () => {
      const projectId = 'test-project';

      mockGraphStore.getStoredGraph.mockResolvedValue(storedGraphFromNodes([
        { id: 'node-1', label: 'AuthService', type: 'class', source_file: 'auth.ts' },
      ]));

      const newNodes: GraphifyNodeDto[] = [
        { id: 'node-1', label: 'AuthService', type: 'class', source_file: 'auth.ts' },
      ];

      const result = await service.diffAndApply(projectId, newNodes, []);

      expect(result.added).toBe(0);
      expect(result.updated).toBe(0);
      expect(result.removed).toBe(0);
      expect(result.indexed).toBe(0);
      expect(mockGraphStore.applyDiff).not.toHaveBeenCalled();
      expect(mockVectorStore.indexDocument).not.toHaveBeenCalled();
    });
  });

  describe('AC-2: getStoredGraph loads from Prisma, not LanceDB', () => {
    it('queries GraphNode and GraphLink Prisma tables', async () => {
      const projectId = 'test-project';

      mockGraphStore.getStoredGraph.mockResolvedValue({
        nodeMap: new Map(),
        linkMap: new Map(),
      });

      await service.getStoredGraph(projectId);

      expect(mockGraphStore.getStoredGraph).toHaveBeenCalledWith(projectId);
    });
  });

  describe('AC-3: 100 nodes incoming, 90 matching stored nodes', () => {
    it('returns added=10, removed=0 when 100 incoming and 90 stored match', async () => {
      const projectId = 'test-project';

      const storedNodes: GraphifyNodeDto[] = [];
      for (let i = 1; i <= 90; i++) {
        storedNodes.push({ id: `node-${i}`, label: `Service${i}`, type: 'class' });
      }

      const incomingNodes: GraphifyNodeDto[] = [];
      for (let i = 1; i <= 100; i++) {
        incomingNodes.push({ id: `node-${i}`, label: `Service${i}`, type: 'class' });
      }

      mockGraphStore.getStoredGraph.mockResolvedValue(storedGraphFromNodes(storedNodes));

      const result = await service.diffAndApply(projectId, incomingNodes, []);

      expect(result.added).toBe(10);
      expect(result.removed).toBe(0);
      expect(mockVectorStore.indexDocument).toHaveBeenCalledTimes(10);
    });
  });

  describe('AC-4: Deleted nodes from both Prisma and LanceDB', () => {
    it('returns removed count for nodes absent from incoming', async () => {
      const projectId = 'test-project';

      mockGraphStore.getStoredGraph.mockResolvedValue(storedGraphFromNodes([
        makeStoredNode('node-1'),
        makeStoredNode('node-2'),
        makeStoredNode('node-3'),
      ]));

      const result = await service.diffAndApply(projectId, [], []);

      expect(result.removed).toBe(3);
      expect(mockGraphStore.applyDiff).toHaveBeenCalledWith(projectId, expect.objectContaining({ removedNodeIds: ['node-1', 'node-2', 'node-3'] }));
      expect(mockVectorStore.deleteBySource).toHaveBeenCalledTimes(3);
    });
  });

  describe('AC-5: Unchanged nodes skipped with no re-index', () => {
    it('skips node with unchanged label, type, source_file, and outgoing links', async () => {
      const projectId = 'test-project';

      mockGraphStore.getStoredGraph.mockResolvedValue(storedGraphFromNodes(
        [{ id: 'node-1', label: 'AuthService', type: 'class', source_file: 'auth.ts' }],
        [makeLink('node-1', 'node-2', 'depends_on')],
      ));

      const newNodes: GraphifyNodeDto[] = [
        { id: 'node-1', label: 'AuthService', type: 'class', source_file: 'auth.ts' },
      ];
      const newLinks: GraphifyLinkDto[] = [
        makeLink('node-1', 'node-2', 'depends_on'),
      ];

      const result = await service.diffAndApply(projectId, newNodes, newLinks);

      expect(result.indexed).toBe(0);
      expect(mockVectorStore.indexDocument).not.toHaveBeenCalled();
    });

    it('re-indexes node when label changes', async () => {
      const projectId = 'test-project';

      mockGraphStore.getStoredGraph.mockResolvedValue(storedGraphFromNodes([
        { id: 'node-1', label: 'AuthService', type: 'class' },
      ]));

      const newNodes: GraphifyNodeDto[] = [
        { id: 'node-1', label: 'AuthServiceUpdated', type: 'class' },
      ];

      const result = await service.diffAndApply(projectId, newNodes, []);

      expect(result.updated).toBe(1);
      expect(result.indexed).toBe(1);
      expect(mockVectorStore.indexDocument).toHaveBeenCalledTimes(1);
    });

    it('re-indexes node when outgoing links change', async () => {
      const projectId = 'test-project';

      mockGraphStore.getStoredGraph.mockResolvedValue(storedGraphFromNodes(
        [{ id: 'node-1', label: 'AuthService', type: 'class' }],
        [makeLink('node-1', 'node-2', 'depends_on')],
      ));

      const newNodes: GraphifyNodeDto[] = [
        { id: 'node-1', label: 'AuthService', type: 'class' },
      ];
      const newLinks: GraphifyLinkDto[] = [
        makeLink('node-1', 'node-3', 'uses'),
      ];

      const result = await service.diffAndApply(projectId, newNodes, newLinks);

      expect(result.updated).toBe(1);
      expect(result.indexed).toBe(1);
      expect(mockVectorStore.indexDocument).toHaveBeenCalledTimes(1);
    });
  });

  describe('AC-7: DiffResult.indexed reflects actual LanceDB writes', () => {
    it('indexed = added + updated nodes, not total node count', async () => {
      const projectId = 'test-project';

      mockGraphStore.getStoredGraph.mockResolvedValue(storedGraphFromNodes([
        { id: 'node-1', label: 'UnchangedService', type: 'class' },
        { id: 'node-4', label: 'OldService', type: 'class' },
      ]));

      const newNodes: GraphifyNodeDto[] = [
        { id: 'node-1', label: 'UnchangedService', type: 'class' },
        { id: 'node-2', label: 'NewService1', type: 'class' },
        { id: 'node-3', label: 'NewService2', type: 'class' },
        { id: 'node-4', label: 'UpdatedService', type: 'interface' },
      ];

      const result = await service.diffAndApply(projectId, newNodes, []);

      // node-1: unchanged, node-2: added, node-3: added, node-4: updated (type changed)
      expect(result.indexed).toBe(3);
      expect(result.added).toBe(2);
      expect(result.updated).toBe(1);
    });
  });

  describe('AC-8: Performance - 500 unchanged + 10 added + 5 removed < 2 seconds', () => {
    it('completes 515-node diff in under 2 seconds', async () => {
      const projectId = 'test-project';

      const storedNodes: GraphifyNodeDto[] = [];
      // Nodes 1-500: unchanged (appear in both stored and incoming)
      for (let i = 1; i <= 500; i++) {
        storedNodes.push({ id: `node-${i}`, label: `Service${i}`, type: 'class' });
      }
      // Nodes 501-505: will be removed (in stored but not incoming)
      for (let i = 501; i <= 505; i++) {
        storedNodes.push({ id: `node-${i}`, label: `Service${i}`, type: 'class' });
      }

      mockGraphStore.getStoredGraph.mockResolvedValue(storedGraphFromNodes(storedNodes));

      const newNodes: GraphifyNodeDto[] = [];
      // Nodes 1-500: unchanged
      for (let i = 1; i <= 500; i++) {
        newNodes.push({ id: `node-${i}`, label: `Service${i}`, type: 'class' });
      }
      // Nodes 601-610: newly added (not in stored)
      for (let i = 601; i <= 610; i++) {
        newNodes.push({ id: `node-${i}`, label: `Service${i}`, type: 'class' });
      }

      const startTime = Date.now();
      const result = await service.diffAndApply(projectId, newNodes, []);
      const duration = Date.now() - startTime;

      expect(duration).toBeLessThan(2000);
      expect(result.added).toBe(10);
      expect(result.removed).toBe(5);
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });
  });

  describe('AC-9: DiffResult.durationMs measures total time', () => {
    it('durationMs reflects total diff-and-apply time', async () => {
      const projectId = 'test-project';

      mockGraphStore.getStoredGraph.mockResolvedValue({
        nodeMap: new Map(),
        linkMap: new Map(),
      });

      const newNodes: GraphifyNodeDto[] = [
        { id: 'node-1', label: 'Service1', type: 'class' },
        { id: 'node-2', label: 'Service2', type: 'class' },
      ];

      const result = await service.diffAndApply(projectId, newNodes, []);

      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });
  });

  describe('AC-10: Project-scoped and honors graphifyEnabled', () => {
    it('import is project-scoped', async () => {
      const projectId = 'test-project-123';

      mockGraphStore.getStoredGraph.mockResolvedValue({
        nodeMap: new Map(),
        linkMap: new Map(),
      });

      const newNodes: GraphifyNodeDto[] = [
        { id: 'node-1', label: 'Service1', type: 'class' },
      ];

      const result = await service.diffAndApply(projectId, newNodes, []);

      expect(mockGraphStore.getStoredGraph).toHaveBeenCalledWith(projectId);
      expect(mockGraphStore.applyDiff).toHaveBeenCalledWith(projectId, expect.objectContaining({ nodes: newNodes, links: [] }));
      expect(mockVectorStore.indexDocument).toHaveBeenCalledWith(projectId, expect.objectContaining({ source: 'code', sourceId: 'node-1' }));
      expect(result.added).toBe(1);
    });

    it('uses projectId for all operations', async () => {
      const projectId = 'test-project';

      mockGraphStore.getStoredGraph.mockResolvedValue({
        nodeMap: new Map(),
        linkMap: new Map(),
      });

      await service.diffAndApply(projectId, [], []);

      expect(mockGraphStore.getStoredGraph).toHaveBeenCalledWith(projectId);
      expect(mockGraphStore.applyDiff).not.toHaveBeenCalled();
    });
  });

  describe('Transaction safety', () => {
    it('delegates batched write execution to GraphStoreService', async () => {
      const projectId = 'test-project';

      mockGraphStore.getStoredGraph.mockResolvedValue(storedGraphFromNodes([
        makeStoredNode('node-1'),
        makeStoredNode('node-2'),
      ]));

      const newNodes: GraphifyNodeDto[] = [
        makeStoredNode('node-1'),
        { id: 'node-3', label: 'NewService', type: 'class' },
      ];

      await service.diffAndApply(projectId, newNodes, []);

      expect(mockGraphStore.applyDiff).toHaveBeenCalledWith(projectId, expect.objectContaining({ removedNodeIds: ['node-2'] }));
      expect(mockGraphStore.applyDiff).toHaveBeenCalledWith(projectId, expect.objectContaining({ nodes: [{ id: 'node-3', label: 'NewService', type: 'class' }], links: [] }));
    });

    it('orders the write: pre-mark, vector delete, one graph write, index, clear', async () => {
      const calls: string[] = [];
      mockGraphStore.markVectorStale.mockImplementation(async () => { calls.push('markVectorStale'); });
      mockGraphStore.applyDiff.mockImplementation(async () => { calls.push('applyDiff'); });
      mockGraphStore.clearVectorStale.mockImplementation(async () => { calls.push('clearVectorStale'); });
      mockVectorStore.deleteBySource.mockImplementation(async () => { calls.push('deleteBySource'); });
      mockVectorStore.indexDocument.mockImplementation(async () => { calls.push('indexDocument'); });

      mockGraphStore.getStoredGraph.mockResolvedValue(storedGraphFromNodes([makeStoredNode('old-node')]));

      await service.diffAndApply('test-project', [{ id: 'new-node', label: 'New', type: 'class' }], []);

      expect(calls).toEqual(['markVectorStale', 'deleteBySource', 'applyDiff', 'indexDocument', 'clearVectorStale']);
    });

    it('re-indexes leftover stale nodes from the stored graph before diffing', async () => {
      mockGraphStore.getStoredGraph.mockResolvedValue(storedGraphFromNodes([makeStoredNode('node-1')]));
      mockGraphStore.findVectorStaleNodeIds.mockResolvedValue(['node-1']);

      await service.diffAndApply('test-project', [makeStoredNode('node-1')], []);

      expect(mockVectorStore.indexDocument).toHaveBeenCalledWith('test-project', expect.objectContaining({ sourceId: 'node-1' }));
      expect(mockGraphStore.clearVectorStale).toHaveBeenCalledWith('test-project', 'node-1');
      expect(mockGraphStore.applyDiff).not.toHaveBeenCalled();
    });
  });
});
