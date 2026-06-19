import { GraphStoreService } from './graph-store.service';
import type { PrismaRagRepository } from './prisma-rag.repository';

function makeRagRepo(): jest.Mocked<PrismaRagRepository> {
  return {
    getStoredGraphNodes: jest.fn(),
    getStoredGraphLinks: jest.fn(),
    upsertNodesInBatches: jest.fn(),
    deleteGraphLinksByNodeIds: jest.fn(),
    deleteGraphNodesByIds: jest.fn(),
    deleteGraphNodeLinks: jest.fn(),
  } as unknown as jest.Mocked<PrismaRagRepository>;
}

describe('GraphStoreService', () => {
  let service: GraphStoreService;
  let ragRepo: jest.Mocked<PrismaRagRepository>;

  beforeEach(() => {
    ragRepo = makeRagRepo();
    service = new GraphStoreService(ragRepo);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('getStoredGraph', () => {
    it('returns empty maps when no nodes or links exist', async () => {
      ragRepo.getStoredGraphNodes.mockResolvedValue([]);
      ragRepo.getStoredGraphLinks.mockResolvedValue([]);

      const result = await service.getStoredGraph('proj-1');

      expect(result.nodeMap.size).toBe(0);
      expect(result.linkMap.size).toBe(0);
    });

    it('builds nodeMap from stored nodes', async () => {
      ragRepo.getStoredGraphNodes.mockResolvedValue([
        { nodeId: 'n1', label: 'AuthService', type: 'class', sourceFile: 'auth.ts', community: null },
        { nodeId: 'n2', label: 'loginFn', type: 'function', sourceFile: null, community: 2 },
      ] as any);
      ragRepo.getStoredGraphLinks.mockResolvedValue([]);

      const { nodeMap } = await service.getStoredGraph('proj-1');

      expect(nodeMap.size).toBe(2);
      expect(nodeMap.get('n1')).toEqual({ id: 'n1', label: 'AuthService', type: 'class', source_file: 'auth.ts', community: undefined });
      expect(nodeMap.get('n2')).toEqual({ id: 'n2', label: 'loginFn', type: 'function', source_file: undefined, community: 2 });
    });

    it('builds linkMap grouped by sourceId', async () => {
      ragRepo.getStoredGraphNodes.mockResolvedValue([]);
      ragRepo.getStoredGraphLinks.mockResolvedValue([
        { sourceId: 'n1', targetId: 'n2', relation: 'CALLS' },
        { sourceId: 'n1', targetId: 'n3', relation: 'IMPORTS' },
        { sourceId: 'n2', targetId: 'n3', relation: null },
      ] as any);

      const { linkMap } = await service.getStoredGraph('proj-1');

      expect(linkMap.size).toBe(2);
      expect(linkMap.get('n1')).toHaveLength(2);
      expect(linkMap.get('n2')).toHaveLength(1);
      expect(linkMap.get('n2')![0]).toEqual({ source: 'n2', target: 'n3', relation: undefined });
    });

    it('fetches nodes and links in parallel', async () => {
      ragRepo.getStoredGraphNodes.mockResolvedValue([]);
      ragRepo.getStoredGraphLinks.mockResolvedValue([]);

      await service.getStoredGraph('proj-abc');

      expect(ragRepo.getStoredGraphNodes).toHaveBeenCalledWith('proj-abc');
      expect(ragRepo.getStoredGraphLinks).toHaveBeenCalledWith('proj-abc');
    });
  });

  describe('upsertNodes', () => {
    it('calls upsertNodesInBatches with mapped shapes', async () => {
      ragRepo.upsertNodesInBatches.mockResolvedValue(undefined);

      await service.upsertNodes(
        'proj-1',
        [{ id: 'n1', label: 'Foo', type: 'class', source_file: 'foo.ts', community: 1 }],
        [{ source: 'n1', target: 'n2', relation: 'CALLS' }],
      );

      expect(ragRepo.upsertNodesInBatches).toHaveBeenCalledWith(
        'proj-1',
        [{ nodeId: 'n1', label: 'Foo', type: 'class', sourceFile: 'foo.ts', community: 1 }],
        [{ sourceId: 'n1', targetId: 'n2', relation: 'CALLS' }],
        ['n1'],
        500,
      );
    });
  });

  describe('deleteNodes', () => {
    it('does nothing when nodeIds is empty', async () => {
      await service.deleteNodes('proj-1', []);

      expect(ragRepo.deleteGraphLinksByNodeIds).not.toHaveBeenCalled();
      expect(ragRepo.deleteGraphNodesByIds).not.toHaveBeenCalled();
    });

    it('deletes links then nodes', async () => {
      ragRepo.deleteGraphLinksByNodeIds.mockResolvedValue(undefined);
      ragRepo.deleteGraphNodesByIds.mockResolvedValue(undefined);

      await service.deleteNodes('proj-1', ['n1', 'n2']);

      expect(ragRepo.deleteGraphLinksByNodeIds).toHaveBeenCalledWith('proj-1', ['n1', 'n2']);
      expect(ragRepo.deleteGraphNodesByIds).toHaveBeenCalledWith('proj-1', ['n1', 'n2']);
    });
  });

  describe('deleteLinks', () => {
    it('does nothing when linkIds is empty', async () => {
      await service.deleteLinks('proj-1', []);

      expect(ragRepo.deleteGraphNodeLinks).not.toHaveBeenCalled();
    });

    it('parses composite link ids and calls deleteGraphNodeLinks', async () => {
      ragRepo.deleteGraphNodeLinks.mockResolvedValue(undefined);

      await service.deleteLinks('proj-1', ['n1::n2', 'n3::n4']);

      expect(ragRepo.deleteGraphNodeLinks).toHaveBeenCalledWith('proj-1', [
        { sourceId: 'n1', targetId: 'n2' },
        { sourceId: 'n3', targetId: 'n4' },
      ]);
    });
  });
});
