/**
 * M19: the graph (Prisma) and its vectors (LanceDB) cannot commit atomically,
 * so the write is retry-safe instead: a failure between the stores leaves
 * nodes vectorStale, and the next import heals them.
 * Run: cd apps/api && bun run test:scoped test/integration/rag/graph-vector-consistency.integration.spec.ts
 */
import { PrismaClient } from '../../../src/generated/prisma/client';
import { PrismaService } from '@nathapp/nestjs-prisma';
import type { IRagConfig } from '../../../src/config/rag.config';
import { PrismaRagRepository } from '../../../src/rag/prisma-rag.repository';
import { GraphStoreService } from '../../../src/rag/graph-store.service';
import { VectorStore } from '../../../src/rag/vector-store.service';
import { IncrementalGraphDiffService } from '../../../src/rag/incremental-graph-diff.service';
import type { GraphifyLinkDto, GraphifyNodeDto } from '../../../src/rag/dto/import-graphify.dto';
import { resetDb } from '../../helpers/reset-db';
import { createPgAdapter } from '../../../src/prisma/pg-adapter';

const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;

const ragConfig = {
  lancedbPath: './lancedb-m19-test',
  inMemoryOnly: true,
  ftsIndexMode: 'simple',
  similarityHigh: 0.85,
  similarityMedium: 0.7,
  similarityLow: 0.5,
} as IRagConfig;

const embedding = {
  embed: async (): Promise<number[]> => Array(8).fill(0.1),
  providerName: 'fake',
  modelName: 'fake-v1',
  dimensions: 8,
};

const txManager = { run: <T>(fn: () => Promise<T>): Promise<T> => fn(), getClient: () => undefined, isInTransaction: () => false };

describeIntegration('M19 graph <-> vector consistency', () => {
  let prismaService: PrismaService<PrismaClient>;
  let repo: PrismaRagRepository;
  let vectorStore: VectorStore;
  let diff: IncrementalGraphDiffService;
  let projectId: string;
  let seq = 0;

  beforeAll(async () => {
    await resetDb();
    prismaService = new PrismaService({ client: PrismaClient, clientOptions: { adapter: createPgAdapter(process.env.DATABASE_URL) } });
    await prismaService.onModuleInit();
    repo = new PrismaRagRepository(prismaService);
    vectorStore = new VectorStore(ragConfig, embedding as never, undefined, repo);
    diff = new IncrementalGraphDiffService(new GraphStoreService(repo), vectorStore, txManager as never);
  });

  afterAll(async () => {
    await prismaService?.onModuleDestroy();
  });

  beforeEach(async () => {
    seq += 1;
    projectId = (
      await prismaService.client.project.create({ data: { name: `M19 ${seq}`, slug: `m19-${seq}-${Date.now()}`, key: `MN${seq}` } })
    ).id;
  });

  const nodes: GraphifyNodeDto[] = [
    { id: 'n1', label: 'AuthService', type: 'class' },
    { id: 'n2', label: 'UserController', type: 'class' },
  ];
  const links: GraphifyLinkDto[] = [{ source: 'n1', target: 'n2', relation: 'uses' }];

  const staleFlags = async (): Promise<Record<string, boolean>> => {
    const rows = await prismaService.client.graphNode.findMany({ where: { projectId }, orderBy: { nodeId: 'asc' } });
    return Object.fromEntries(rows.map((r) => [r.nodeId, r.vectorStale]));
  };
  const vectorSourceIds = async (): Promise<string[]> =>
    (await vectorStore.listDocuments(projectId)).map((d) => d.sourceId).sort();

  it('a crash between the graph commit and re-indexing heals on the next import', async () => {
    const spy = jest.spyOn(vectorStore, 'indexDocument').mockRejectedValueOnce(new Error('lance down'));
    await expect(diff.diffAndApply(projectId, nodes, links)).rejects.toThrow('lance down');
    spy.mockRestore();

    expect(await staleFlags()).toEqual({ n1: true, n2: true });

    await diff.diffAndApply(projectId, nodes, links);

    expect(await staleFlags()).toEqual({ n1: false, n2: false });
    expect(await vectorSourceIds()).toEqual(['n1', 'n2']);
  });

  it('a failed graph write after the vector delete still leaves the node healable', async () => {
    await diff.diffAndApply(projectId, nodes, links);

    const renamed = [{ ...nodes[0], label: 'AuthServiceV2' }, nodes[1]];
    const spy = jest.spyOn(repo, 'applyGraphDiff').mockRejectedValueOnce(new Error('pg down'));
    await expect(diff.diffAndApply(projectId, renamed, links)).rejects.toThrow('pg down');
    spy.mockRestore();

    // The graph still holds the original label and the vector is gone; the
    // pre-mark means an import of the ORIGINAL (unchanged) graph re-indexes it.
    expect(await staleFlags()).toEqual({ n1: true, n2: false });
    await diff.diffAndApply(projectId, nodes, links);

    expect(await staleFlags()).toEqual({ n1: false, n2: false });
    const docs = await vectorStore.listDocuments(projectId);
    const n1Content = docs.find((d) => d.sourceId === 'n1')?.content ?? '';
    expect(n1Content).toContain('class AuthService');
    expect(n1Content).not.toContain('AuthServiceV2');
  });

  it('stores duplicate links once, including links with no relation', async () => {
    const dupLinks: GraphifyLinkDto[] = [
      { source: 'n1', target: 'n2', relation: 'uses' },
      { source: 'n1', target: 'n2', relation: 'uses' },
      { source: 'n1', target: 'n2' },
      { source: 'n1', target: 'n2' },
    ];

    await diff.diffAndApply(projectId, nodes, dupLinks);

    const stored = await prismaService.client.graphLink.findMany({ where: { projectId } });
    expect(stored).toHaveLength(2);
  });

  it('removed nodes lose their graph rows, their links and their vectors', async () => {
    await diff.diffAndApply(projectId, nodes, links);
    await diff.diffAndApply(projectId, [nodes[1]], []);

    expect(await staleFlags()).toEqual({ n2: false });
    expect(await prismaService.client.graphLink.count({ where: { projectId } })).toBe(0);
    expect(await vectorSourceIds()).toEqual(['n2']);
  });
});
