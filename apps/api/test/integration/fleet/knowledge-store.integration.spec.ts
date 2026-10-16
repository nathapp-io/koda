/**
 * Fleet S5b knowledge index US-001 — the chunk store on a real temp-dir LanceDB (needs no database) and the
 * state repository on Postgres (KODA_DB_TESTS=1).
 * US-002 adds hybrid search over the same store: one embedded and one unembedded chunk (AC-8).
 *
 * Run: cd apps/api && KODA_DB_TESTS=1 bun run test:scoped test/integration/fleet/knowledge-store.integration.spec.ts
 */
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Index } from '@lancedb/lancedb';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { PrismaClient, Prisma } from '../../../src/generated/prisma/client';
import { createPgAdapter } from '../../../src/prisma/pg-adapter';
import type { IRagConfig } from '../../../src/config/rag.config';
import { LanceRecord, LanceTableManager } from '../../../src/rag/lance-table-manager';
import { EmbeddingService } from '../../../src/rag/embedding.service';
import { HybridRetrieverService } from '../../../src/rag/hybrid-retriever.service';
import { VectorStore } from '../../../src/rag/vector-store.service';
import type { EntityStore } from '../../../src/rag/entity-store';
import type { PrismaRagRepository } from '../../../src/rag/prisma-rag.repository';
import { KnowledgeChunkStore } from '../../../src/fleet/knowledge/knowledge-chunk-store';
import { MAX_KNOWLEDGE_FILES } from '../../../src/fleet/knowledge/knowledge-allowlist';
import type { KnowledgeIndexService } from '../../../src/fleet/knowledge/knowledge-index.service';
import { KnowledgeSearchService } from '../../../src/fleet/knowledge/knowledge-search.service';
import { PrismaKnowledgeIndexRepository } from '../../../src/fleet/knowledge/prisma-knowledge-index.repository';
import { resetDb } from '../../helpers/reset-db';
import { seedFleetBase } from '../../helpers/fleet-fixtures';

vi.setConfig({ testTimeout: 30_000 });

const DIMS = 4;
const PROJECT = 'proj_knowledge_store';

function chunk(sourceId: string, chunkIndex: number, source = 'repo'): LanceRecord {
  return {
    id: `${sourceId}#${chunkIndex}`,
    source,
    source_id: sourceId,
    content: `content ${sourceId} ${chunkIndex}`,
    vector: [chunkIndex, 1, 0, 0],
    metadata: JSON.stringify({ chunkIndex, chunkCount: 3, path: sourceId, title: `t${chunkIndex}` }),
    created_at: '2026-10-20T00:00:00.000Z',
    provider: 'fake',
    model: 'fake-v1',
  };
}

describe('KnowledgeChunkStore on LanceDB', () => {
  let root: string;
  let manager: LanceTableManager;
  let store: KnowledgeChunkStore;

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'koda-knowledge-store-'));
    const ragConfig = { lancedbPath: root, inMemoryOnly: false } as IRagConfig;
    manager = new LanceTableManager(ragConfig, { providerName: 'fake', modelName: 'fake-v1', dimensions: DIMS } as never);
    manager.ensureStorage();
    store = new KnowledgeChunkStore(manager);
  });

  afterAll(async () => {
    await manager.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('replaceFile then readFile returns the rows in chunkIndex order (AC-7)', async () => {
    const sourceId = 'repo:r1:docs/a.md';
    await store.replaceFile(PROJECT, sourceId, [chunk(sourceId, 2), chunk(sourceId, 0), chunk(sourceId, 1)]);
    const rows = await store.readFile(PROJECT, sourceId);
    expect(rows.map((r) => r.chunkIndex)).toEqual([0, 1, 2]);
    expect(rows.map((r) => r.id)).toEqual([`${sourceId}#0`, `${sourceId}#1`, `${sourceId}#2`]);
    expect(rows[0]).toMatchObject({ sourceId, provider: 'fake', title: 't0' });
  });

  it('a second replaceFile leaves only its row and does not touch another file (AC-8)', async () => {
    const a = 'repo:r1:docs/a.md';
    const b = 'repo:r1:docs/b.md';
    await store.replaceFile(PROJECT, a, [chunk(a, 0), chunk(a, 1), chunk(a, 2)]);
    await store.replaceFile(PROJECT, b, [chunk(b, 0), chunk(b, 1)]);
    await store.replaceFile(PROJECT, a, [chunk(a, 0)]);
    expect((await store.readFile(PROJECT, a)).map((r) => r.id)).toEqual([`${a}#0`]);
    expect((await store.readFile(PROJECT, b)).map((r) => r.id)).toEqual([`${b}#0`, `${b}#1`]);
  });

  it('deleteFile removes the file rows and keeps a ticket row of the same table (AC-9)', async () => {
    const a = 'repo:r1:docs/a.md';
    await store.replaceFile(PROJECT, a, [chunk(a, 0), chunk(a, 1)]);
    const table = await manager.getOrCreateTable(`project_${PROJECT}`);
    await table.add([chunk('ticket:t1', 0, 'ticket')]);
    await store.deleteFile(PROJECT, a);
    expect(await store.readFile(PROJECT, a)).toEqual([]);
    expect((await store.readFile(PROJECT, 'ticket:t1')).map((r) => r.id)).toEqual(['ticket:t1#0']);
  });

  it('vector search honours the predicate', async () => {
    const c = 'repo:r1:docs/c.md';
    await store.replaceFile(PROJECT, c, [chunk(c, 0), chunk(c, 1)]);
    const hits = await store.vector(PROJECT, [1, 1, 0, 0], `source = 'repo' AND source_id = '${c}'`, 5);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((h) => h.sourceId === c)).toBe(true);
  });
});

/**
 * US-002 AC-8: hybrid search on a real LanceDB with the fake embedding provider — one embedded chunk and one
 * `provider: 'none'` chunk of the same text. The `none` chunk is invisible to the vector leg (its predicate is
 * `provider != 'none'`), so its score is only its lexical rank.
 */
describe('KnowledgeSearchService on LanceDB', () => {
  const PROJECT = 'proj_knowledge_search';
  const TEXT = 'The fleet broker mints a read-only token for the runner';
  const EMBEDDED_ID = 'repo:r1:docs/a.md';
  const UNEMBEDDED_ID = 'repo:r1:docs/b.md';

  let root: string;
  let manager: LanceTableManager;
  let embedding: EmbeddingService;
  let store: KnowledgeChunkStore;
  let service: KnowledgeSearchService;

  /** A `repo` chunk row of 1c-c-D4 whose text is the searchable `content`. */
  function record(sourceId: string, path: string, vector: number[], provider: string): LanceRecord {
    return {
      id: `${sourceId}#0`,
      source: 'repo',
      source_id: sourceId,
      content: TEXT,
      vector,
      metadata: JSON.stringify({
        repoId: 'r1', owner: 'o', name: 'n', path, sha: 'sha-1', blobSha: 'blob-1', title: 'Broker',
        headingPath: 'Broker', anchor: 'broker', chunkIndex: 0, chunkCount: 1, abstract: 'abstract', text: TEXT,
      }),
      created_at: '2026-10-20T00:00:00.000Z',
      provider,
      model: provider === 'none' ? '' : 'fake-v1',
    };
  }

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'koda-knowledge-search-'));
    const ragConfig = { lancedbPath: root, inMemoryOnly: false } as IRagConfig;
    embedding = new EmbeddingService({ ...ragConfig, embeddingProvider: 'fake', embeddingModel: 'fake-v1' } as IRagConfig);
    manager = new LanceTableManager(ragConfig, embedding);
    manager.ensureStorage();
    store = new KnowledgeChunkStore(manager);
    const index = {
      listProjectRepos: async () => [{ id: 'r1', projectId: PROJECT, provider: 'github', owner: 'o', name: 'n', defaultBranch: 'main', githubInstallationId: null }],
    };
    service = new KnowledgeSearchService(store, embedding, index as unknown as KnowledgeIndexService);
  });

  afterAll(async () => {
    await manager.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('AC-8: returns both the embedded and the unembedded chunk, scoring the unembedded one by its lexical rank', async () => {
    const tableName = `project_${PROJECT}`;
    const vector = await embedding.embed(TEXT);
    await store.replaceFile(PROJECT, EMBEDDED_ID, [record(EMBEDDED_ID, 'docs/a.md', vector, embedding.providerName)]);
    await store.replaceFile(PROJECT, UNEMBEDDED_ID, [record(UNEMBEDDED_ID, 'docs/b.md', new Array(vector.length).fill(0), 'none')]);
    // 1c-c-D5: a pass optimizes the table once after writing; the lexical leg repairs the full-text index the
    // deletes dropped (see KnowledgeChunkStore.lexical), so the search below runs on the indexer's end state.
    const table = await manager.getOrCreateTable(tableName);
    await manager.exclusive(tableName, () => table.optimize());

    const result = await service.search({ projectId: PROJECT, query: TEXT, limit: 20 });

    expect(result.lexicalOnly).toBe(false);
    expect(result.empty).toBe(false);
    expect(result.hits.map((hit) => hit.path).sort()).toEqual(['docs/a.md', 'docs/b.md']);

    const lexical = await store.lexical(PROJECT, TEXT, "source = 'repo'", 50);
    const unembeddedRank = lexical.findIndex((row) => row.id === `${UNEMBEDDED_ID}#0`) + 1;
    expect(lexical.map((row) => row.id)).toEqual(expect.arrayContaining([`${EMBEDDED_ID}#0`, `${UNEMBEDDED_ID}#0`]));
    expect(unembeddedRank).toBeGreaterThan(0);

    const unembeddedHit = result.hits.find((hit) => hit.path === 'docs/b.md');
    expect(unembeddedHit?.score).toBe(1 / (60 + unembeddedRank));
    // The embedded chunk is in both legs, so it scores strictly better than a single lexical rank.
    expect(result.hits.find((hit) => hit.path === 'docs/a.md')?.score).toBeGreaterThan(1 / 61);
  });
});

/**
 * Fleet S5b US-005/AC-12: the source filter on a real LanceDB — one repository chunk and one outcome chunk of
 * the same table, carrying the same text. Each leg is restricted by the asked source, so `docs` answers the
 * repository chunk alone, `outcomes` the outcome chunk alone, and `all` both.
 */
describe('KnowledgeSearchService source filter on LanceDB (US-005)', () => {
  const PROJECT = 'proj_knowledge_sources';
  const TEXT = 'The fleet broker mints a read-only token for the runner';
  const DOC_ID = 'repo:r1:docs/a.md';
  const OUTCOME_ID = 'outcome:r1:j1:report';

  let root: string;
  let manager: LanceTableManager;
  let embedding: EmbeddingService;
  let store: KnowledgeChunkStore;
  let service: KnowledgeSearchService;

  /** One chunk row of the source it belongs to, with the metadata 3c-2-D4/D6 write. */
  function record(source: 'repo' | 'outcome', sourceId: string, path: string, vector: number[]): LanceRecord {
    return {
      id: `${sourceId}#0`,
      source,
      source_id: sourceId,
      content: TEXT,
      vector,
      metadata: JSON.stringify({
        repoId: 'r1', owner: 'o', name: 'n', path, sha: 'sha-1', blobSha: 'blob-1', title: 'Broker',
        headingPath: 'Broker', anchor: 'broker', chunkIndex: 0, chunkCount: 1, abstract: 'abstract', text: TEXT,
        ...(source === 'outcome' ? { jobId: 'j1', feature: 'f', outcomeKind: 'report' } : {}),
      }),
      created_at: '2026-10-20T00:00:00.000Z',
      provider: embedding.providerName,
      model: 'fake-v1',
    };
  }

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'koda-knowledge-sources-'));
    const ragConfig = { lancedbPath: root, inMemoryOnly: false } as IRagConfig;
    embedding = new EmbeddingService({ ...ragConfig, embeddingProvider: 'fake', embeddingModel: 'fake-v1' } as IRagConfig);
    manager = new LanceTableManager(ragConfig, embedding);
    manager.ensureStorage();
    store = new KnowledgeChunkStore(manager);
    const index = {
      listProjectRepos: async () => [{ id: 'r1', projectId: PROJECT, provider: 'github', owner: 'o', name: 'n', defaultBranch: 'main', githubInstallationId: null }],
      describeJobs: async (_projectId: string, jobIds: string[]) =>
        jobIds.map((jobId) => ({ jobId, repoId: 'r1', feature: 'f', state: 'COMPLETED', prUrl: null, prState: null })),
    };
    service = new KnowledgeSearchService(store, embedding, index as unknown as KnowledgeIndexService);

    const vector = await embedding.embed(TEXT);
    await store.replaceFile(PROJECT, DOC_ID, [record('repo', DOC_ID, 'docs/a.md', vector)]);
    await store.replaceFile(PROJECT, OUTCOME_ID, [record('outcome', OUTCOME_ID, 'feature-report.md', vector)]);
    // The indexer's end state: one `optimize` after writing (1c-c-D5); the lexical leg repairs the full-text
    // index the deletes dropped, exactly as the AC-8 case above relies on.
    const table = await manager.getOrCreateTable(`project_${PROJECT}`);
    await manager.exclusive(`project_${PROJECT}`, () => table.optimize());
  });

  afterAll(async () => {
    await manager.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('AC-12: source all answers both the repository and the outcome chunk', async () => {
    const result = await service.search({ projectId: PROJECT, query: TEXT, source: 'all', limit: 20 });

    expect(result.lexicalOnly).toBe(false);
    expect(result.empty).toBe(false);
    expect(result.hits.map((hit) => `${hit.source}:${hit.path}`).sort()).toEqual(['outcome:feature-report.md', 'repo:docs/a.md']);

    const outcome = result.hits.find((hit) => hit.source === 'outcome');
    expect(outcome).toMatchObject({ jobId: 'j1', feature: 'f', outcomeKind: 'report', jobState: 'COMPLETED', prState: null, prUrl: null });
  });

  it("AC-12: source 'docs' answers the repository chunk alone", async () => {
    const result = await service.search({ projectId: PROJECT, query: TEXT, source: 'docs', limit: 20 });

    expect(result.hits.map((hit) => `${hit.source}:${hit.path}`)).toEqual(['repo:docs/a.md']);
  });

  it("AC-12: source 'outcomes' answers the outcome chunk alone and is not empty", async () => {
    const result = await service.search({ projectId: PROJECT, query: TEXT, source: 'outcomes', limit: 20 });

    expect(result.empty).toBe(false);
    expect(result.hits.map((hit) => `${hit.source}:${hit.path}`)).toEqual(['outcome:feature-report.md']);
  });
});

/**
 * 1c-c-R6: repository chunks share the project's LanceDB table with ticket documents, and 3c-2-D6 puts run
 * outcomes in the same table, so a pass that indexes hundreds of matching chunks of either knowledge source must
 * not be able to crowd ticket search out of its bounded candidate pools. The review reproduced the opposite on a
 * real table: `search` returned ticket t1 before 120 relevant repository chunks were indexed and no results
 * afterwards, and `VectorStore.search` answered five outcome rows.
 */
describe('Ticket search isolation on the shared table (1c-c-R6)', () => {
  const PROJECT = 'proj_ticket_isolation';
  const QUERY = 'broker token cache design';
  const TICKET_ID = 'ticket-t1';
  const REPO_CHUNKS = 120;
  const OUTCOME_CHUNKS = 120;

  let root: string;
  let manager: LanceTableManager;
  let embedding: EmbeddingService;
  let retriever: HybridRetrieverService;
  let vectorStore: VectorStore;

  /** One knowledge row — a repository chunk or a run-outcome chunk — that matches the query harder than the ticket. */
  function knowledgeRow(source: 'repo' | 'outcome', i: number, queryVector: number[]): LanceRecord {
    const sourceId = source === 'repo' ? `repo:r1:docs/${i}.md` : `outcome:r1:job${i}:report`;
    const path = source === 'repo' ? `docs/${i}.md` : 'feature-report.md';
    return {
      id: `${sourceId}#0`, source, source_id: sourceId,
      content: Array(6).fill(QUERY).join(' '), vector: queryVector,
      metadata: JSON.stringify({
        repoId: 'r1', owner: 'o', name: 'n', path, sha: 'sha-1', blobSha: '', title: 'Broker',
        headingPath: 'Broker', anchor: 'broker', chunkIndex: 0, chunkCount: 1, abstract: 'abstract', text: QUERY,
        ...(source === 'outcome' ? { jobId: `job${i}`, feature: 'f', outcomeKind: 'report' } : {}),
      }),
      created_at: '2026-10-20T00:00:00.000Z', provider: embedding.providerName, model: embedding.modelName,
    };
  }

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'koda-ticket-isolation-'));
    const ragConfig = { lancedbPath: root, inMemoryOnly: false } as IRagConfig;
    embedding = new EmbeddingService({ ...ragConfig, embeddingProvider: 'fake', embeddingModel: 'fake-v1' } as IRagConfig);
    manager = new LanceTableManager(ragConfig, embedding);
    manager.ensureStorage();
    retriever = new HybridRetrieverService(
      ragConfig,
      embedding,
      { searchEntities: () => [], computeEntityScore: () => 0 } as unknown as EntityStore,
      { findProjectGraphifyEnabled: async () => ({ graphifyEnabled: false }) } as unknown as PrismaRagRepository,
      manager,
    );
    vectorStore = new VectorStore(ragConfig, embedding, undefined, undefined, undefined, manager);

    const queryVector = await embedding.embed(QUERY);
    const tableName = `project_${PROJECT}`;
    const table = await manager.getOrCreateTable(tableName);
    // The ticket matches the query, but strictly weaker than the knowledge chunks do: its vector is the query
    // vector turned away from itself, and its text repeats the query terms once instead of six times.
    const ticketVector = [...queryVector];
    ticketVector[0] += 0.5;
    await manager.addRecord(tableName, table, {
      id: TICKET_ID, source: 'ticket', source_id: 't1', content: QUERY, vector: ticketVector,
      metadata: '{"ref":"KODA-1"}', created_at: '2026-10-20T00:00:00.000Z',
      provider: embedding.providerName, model: embedding.modelName,
    });

    const rows: LanceRecord[] = [
      ...Array.from({ length: REPO_CHUNKS }, (_, i) => knowledgeRow('repo', i, queryVector)),
      ...Array.from({ length: OUTCOME_CHUNKS }, (_, i) => knowledgeRow('outcome', i, queryVector)),
    ];
    // The full-text index is created last, on the final row set, so the native FTS leg (not the scan fallback)
    // ranks the chunks: a pass leaves the table in exactly this state (1c-c-D5).
    await manager.exclusive(tableName, async () => {
      await table.add(rows);
      await table.createIndex('content', { config: Index.fts(), replace: true });
    });
  });

  afterAll(async () => {
    await manager.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('returns the matching ticket instead of an empty result', async () => {
    const result = await retriever.search({ projectId: PROJECT, query: QUERY, limit: 20 });

    expect(result.results.map((row) => row.id)).toContain(TICKET_ID);
  });

  it('never returns a repository or outcome chunk from ticket search', async () => {
    const result = await retriever.search({ projectId: PROJECT, query: QUERY, limit: 20 });

    expect(result.results.map((row) => row.source)).not.toContain('repo');
    expect(result.results.map((row) => row.source)).not.toContain('outcome');
  });

  it('VectorStore.search answers the ticket and never an outcome chunk (1c-c-R6)', async () => {
    const result = await vectorStore.search(PROJECT, QUERY, 5);

    expect(result.results.map((row) => row.source)).not.toContain('outcome');
    expect(result.results.map((row) => row.source)).not.toContain('repo');
    expect(result.results.map((row) => row.id)).toContain(TICKET_ID);
  });

  it('leaves the repository chunks readable through the knowledge search path', async () => {
    const store = new KnowledgeChunkStore(manager);
    const service = new KnowledgeSearchService(
      store,
      embedding,
      { listProjectRepos: async () => [{ id: 'r1', projectId: PROJECT, provider: 'github', owner: 'o', name: 'n', defaultBranch: 'main', githubInstallationId: null }] } as unknown as KnowledgeIndexService,
    );

    const result = await service.search({ projectId: PROJECT, query: QUERY, limit: 20 });

    expect(result.empty).toBe(false);
    expect(result.hits.length).toBeGreaterThan(0);
    expect(result.hits.every((hit) => hit.repoId === 'r1')).toBe(true);
  });
});

const describePg = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;

describePg('PrismaKnowledgeIndexRepository (PG)', () => {
  let prisma: PrismaService<PrismaClient>;
  let repo: PrismaKnowledgeIndexRepository;

  beforeAll(async () => {
    await resetDb();
    prisma = new PrismaService({ client: PrismaClient, clientOptions: { adapter: createPgAdapter(process.env.DATABASE_URL) } });
    await prisma.onModuleInit();
    repo = new PrismaKnowledgeIndexRepository(prisma);
  });

  afterAll(async () => {
    await prisma.onModuleDestroy();
  });

  const LEASE_MS = 900_000;
  const NOW = new Date('2026-10-20T10:00:00.000Z');
  const minutes = (n: number): Date => new Date(NOW.getTime() + n * 60_000);

  it('claim creates a running row with a 15 minute lease and a second claim answers false (AC-4)', async () => {
    const { repoId, projectId } = await seedFleetBase(prisma.client);
    expect(await repo.claim(repoId, projectId, NOW, LEASE_MS)).toBe(true);
    const row = await prisma.client.knowledgeRepoIndex.findUniqueOrThrow({ where: { repoId } });
    expect(row.status).toBe('running');
    expect(row.leaseUntil?.toISOString()).toBe(minutes(15).toISOString());
    expect(await repo.claim(repoId, projectId, minutes(1), LEASE_MS)).toBe(false);
  });

  it('a claim 16 minutes after the first answers true (AC-5)', async () => {
    const { repoId, projectId } = await seedFleetBase(prisma.client);
    expect(await repo.claim(repoId, projectId, NOW, LEASE_MS)).toBe(true);
    expect(await repo.claim(repoId, projectId, minutes(16), LEASE_MS)).toBe(true);
  });

  it('finish releases the lease so the next claim succeeds, and keeps indexedSha when undefined', async () => {
    const { repoId, projectId } = await seedFleetBase(prisma.client);
    await repo.claim(repoId, projectId, NOW, LEASE_MS);
    const base = { projectId, fileCount: 2, chunkCount: 5, unembeddedCount: 0, skippedCount: 1, finishedAt: minutes(2) };
    await repo.finish(repoId, { ...base, status: 'idle', indexedSha: 'abc', lastError: null });
    await repo.claim(repoId, projectId, minutes(3), LEASE_MS);
    await repo.finish(repoId, { ...base, status: 'failed', lastError: 'boom' });
    const row = await prisma.client.knowledgeRepoIndex.findUniqueOrThrow({ where: { repoId } });
    expect(row).toMatchObject({ status: 'failed', indexedSha: 'abc', lastError: 'boom', leaseUntil: null });
    expect(await repo.claim(repoId, projectId, minutes(4), LEASE_MS)).toBe(true);
  });

  it('renew extends a running lease only', async () => {
    const { repoId, projectId } = await seedFleetBase(prisma.client);
    expect(await repo.renew(repoId, minutes(30))).toBe(false);
    await repo.claim(repoId, projectId, NOW, LEASE_MS);
    expect(await repo.renew(repoId, minutes(30))).toBe(true);
    const row = await prisma.client.knowledgeRepoIndex.findUniqueOrThrow({ where: { repoId } });
    expect(row.leaseUntil?.toISOString()).toBe(minutes(30).toISOString());
  });

  it('file rows round-trip through upsertFile, listFiles and deleteFile', async () => {
    const { repoId } = await seedFleetBase(prisma.client);
    await repo.upsertFile({ repoId, path: 'docs/a.md', blobSha: 's1', chunkCount: 2, unembeddedCount: 0 });
    await repo.upsertFile({ repoId, path: 'docs/a.md', blobSha: 's2', chunkCount: 3, unembeddedCount: 1 });
    expect(await repo.listFiles(repoId)).toEqual([{ repoId, path: 'docs/a.md', blobSha: 's2', chunkCount: 3, unembeddedCount: 1 }]);
    await repo.deleteFile(repoId, 'docs/a.md');
    expect(await repo.listFiles(repoId)).toEqual([]);
  });

  it('listFiles reads every persisted state past the 2000-file corpus cap (US-004/AC-5)', async () => {
    // An interrupted corpus replacement leaves the new files' rows written and the old files' rows not yet
    // deleted — more rows than the cap. The cleanup step must still see all of them.
    const { repoId } = await seedFleetBase(prisma.client);
    const count = MAX_KNOWLEDGE_FILES + 1;
    await prisma.client.knowledgeRepoFile.createMany({
      data: Array.from({ length: count }, (_, i) => ({
        repoId, path: `docs/${String(i).padStart(5, '0')}.md`, blobSha: 'sha', chunkCount: 1, unembeddedCount: 0,
      })),
    });

    const files = await repo.listFiles(repoId);

    expect(files).toHaveLength(count);
    expect(files[0].path).toBe('docs/00000.md');
    expect(files[count - 1].path).toBe(`docs/${String(count - 1).padStart(5, '0')}.md`);
  });

  it('deleting a FleetRepo cascades to its index and file rows (AC-6)', async () => {
    const { repoId, projectId } = await seedFleetBase(prisma.client);
    await repo.claim(repoId, projectId, NOW, LEASE_MS);
    await repo.upsertFile({ repoId, path: 'README.md', blobSha: 's', chunkCount: 1, unembeddedCount: 0 });
    await prisma.client.fleetRepo.delete({ where: { id: repoId } });
    expect(await prisma.client.knowledgeRepoIndex.count({ where: { repoId } })).toBe(0);
    expect(await prisma.client.knowledgeRepoFile.count({ where: { repoId } })).toBe(0);
  });

  it('findProjectRepos is scoped to the project and findAllGithubRepos needs an installation', async () => {
    const { projectId, repoId } = await seedFleetBase(prisma.client);
    const other = await seedFleetBase(prisma.client);
    expect((await repo.findProjectRepos(projectId)).map((r) => r.id)).toEqual([repoId]);
    const all = (await repo.findAllGithubRepos()).map((r) => r.id);
    expect(all).toEqual(expect.arrayContaining([repoId, other.repoId]));
    await prisma.client.fleetRepo.update({ where: { id: repoId }, data: { githubInstallationId: null } });
    expect((await repo.findAllGithubRepos()).map((r) => r.id)).not.toContain(repoId);
  });

  it('AC-11: saveProjectPatterns round-trips a list and null deletes the row', async () => {
    const { projectId } = await seedFleetBase(prisma.client);

    expect(await repo.findProjectPatterns(projectId)).toBeNull();

    await repo.saveProjectPatterns(projectId, ['a/*.md']);
    expect(await repo.findProjectPatterns(projectId)).toEqual(['a/*.md']);

    await repo.saveProjectPatterns(projectId, ['b/*.md']);
    expect(await repo.findProjectPatterns(projectId)).toEqual(['b/*.md']);

    await repo.saveProjectPatterns(projectId, null);
    expect(await repo.findProjectPatterns(projectId)).toBeNull();
    expect(await prisma.client.knowledgeProjectPatterns.count({ where: { projectId } })).toBe(0);
  });

  it('AC-11: a finish with a patternsKey is read back by listStates', async () => {
    const { projectId, repoId } = await seedFleetBase(prisma.client);
    const base = { projectId, fileCount: 1, chunkCount: 2, unembeddedCount: 0, skippedCount: 0, lastError: null, finishedAt: minutes(5) };

    await repo.finish(repoId, { ...base, status: 'idle', indexedSha: 'abc', patternsKey: 'x' });

    const [state] = await repo.listStates(projectId);
    expect(state).toMatchObject({ repoId, patternsKey: 'x', indexedSha: 'abc' });
  });

  it('AC-11: a finish without a patternsKey leaves the stored one alone', async () => {
    const { projectId, repoId } = await seedFleetBase(prisma.client);
    const base = { projectId, fileCount: 1, chunkCount: 2, unembeddedCount: 0, skippedCount: 0, lastError: null, finishedAt: minutes(5) };

    await repo.finish(repoId, { ...base, status: 'idle', patternsKey: 'handbook/*.md' });
    await repo.finish(repoId, { ...base, status: 'failed', lastError: 'boom' });

    const [state] = await repo.listStates(projectId);
    expect(state).toMatchObject({ patternsKey: 'handbook/*.md', status: 'failed', lastError: 'boom' });
  });

  it('deleting a project cascades to its patterns row', async () => {
    const { projectId } = await seedFleetBase(prisma.client);
    await repo.saveProjectPatterns(projectId, ['a/*.md']);

    await prisma.client.project.delete({ where: { id: projectId } });

    expect(await prisma.client.knowledgeProjectPatterns.count({ where: { projectId } })).toBe(0);
  });
});

/**
 * Fleet S5b US-004 (3c-2-D4): the outcome read the indexing pass projects. Same PG harness as above; the
 * epoch selection is what has to be real here, so every case seeds `FleetBundleIngest` and
 * `FleetRunOutcome` rows rather than faking the client.
 */
describePg('PrismaKnowledgeIndexRepository.findRunOutcomes (PG)', () => {
  let prisma: PrismaService<PrismaClient>;
  let repo: PrismaKnowledgeIndexRepository;

  beforeAll(async () => {
    await resetDb();
    prisma = new PrismaService({ client: PrismaClient, clientOptions: { adapter: createPgAdapter(process.env.DATABASE_URL) } });
    await prisma.onModuleInit();
    repo = new PrismaKnowledgeIndexRepository(prisma);
  });

  afterAll(async () => {
    await prisma.onModuleDestroy();
  });

  /** A COMPLETED RUN job of its own project/repo with one artifact, ingest row and outcomes per epoch. */
  const seedRunJob = async (
    epochs: Array<{ epoch: number; status: string; outcomes?: Array<{ kind: string; content: string }> }>,
  ): Promise<{ jobId: string; projectId: string; repoId: string; owner: string; name: string }> => {
    const { projectId, repoId, adminId } = await seedFleetBase(prisma.client);
    const { owner, name } = await prisma.client.fleetRepo.findUniqueOrThrow({ where: { id: repoId } });
    const job = await prisma.client.fleetJob.create({
      data: {
        projectId, repoId, ref: 'main', command: 'RUN', feature: 'f', profiles: [], selectorLabels: [],
        maxCostUsd: new Prisma.Decimal(1), requestedById: adminId, state: 'COMPLETED', resultSha: 'abc1234',
      },
    });
    for (const { epoch, status, outcomes = [] } of epochs) {
      const artifact = await prisma.client.fleetJobArtifact.create({
        data: { jobId: job.id, leaseEpoch: epoch, kind: 'bundle', storageKey: `jobs/${job.id}/${epoch}/a.tar.gz`, sizeBytes: BigInt(1), sha256: 'a'.repeat(64) },
      });
      await prisma.client.fleetBundleIngest.create({
        data: { artifactId: artifact.id, jobId: job.id, leaseEpoch: epoch, status, parserVersion: 3, ingestedAt: new Date('2026-10-20T10:00:00.000Z') },
      });
      if (outcomes.length > 0) {
        await prisma.client.fleetRunOutcome.createMany({
          data: outcomes.map((o) => ({ jobId: job.id, leaseEpoch: epoch, projectId, repoId, kind: o.kind, content: o.content })),
        });
      }
    }
    return { jobId: job.id, projectId, repoId, owner, name };
  };

  it('AC-14: answers the highest ingested epoch only, with the repository owner and name', async () => {
    const seeded = await seedRunJob([
      { epoch: 1, status: 'done', outcomes: [{ kind: 'report', content: '# run 1' }] },
      { epoch: 2, status: 'partial', outcomes: [{ kind: 'report', content: '# run 2' }, { kind: 'decisions', content: '{"id":"D-1"}' }] },
    ]);

    const found = await repo.findRunOutcomes(seeded.jobId);

    expect(found?.job).toEqual({
      id: seeded.jobId, projectId: seeded.projectId, repoId: seeded.repoId,
      owner: seeded.owner, name: seeded.name, feature: 'f', resultSha: 'abc1234',
    });
    expect(found?.outcomes).toEqual([{ kind: 'report', content: '# run 2' }, { kind: 'decisions', content: '{"id":"D-1"}' }]);
  });

  it('AC-15: a newer ingest without an outcome row retires the earlier epoch', async () => {
    const seeded = await seedRunJob([
      { epoch: 1, status: 'done', outcomes: [{ kind: 'report', content: '# run 1' }] },
      { epoch: 2, status: 'done' },
    ]);

    expect((await repo.findRunOutcomes(seeded.jobId))?.outcomes).toEqual([]);
  });

  it('a failed ingest never retires the outcomes of the attempt before it', async () => {
    const seeded = await seedRunJob([
      { epoch: 1, status: 'done', outcomes: [{ kind: 'report', content: '# run 1' }] },
      { epoch: 2, status: 'failed' },
    ]);

    expect((await repo.findRunOutcomes(seeded.jobId))?.outcomes).toEqual([{ kind: 'report', content: '# run 1' }]);
  });

  it('answers an empty list for a job whose only ingest never succeeded, and null for an unknown job', async () => {
    const seeded = await seedRunJob([{ epoch: 1, status: 'pending' }]);

    expect((await repo.findRunOutcomes(seeded.jobId))?.outcomes).toEqual([]);
    expect(await repo.findRunOutcomes('missing')).toBeNull();
  });
});

/**
 * Fleet S5b US-005/AC-10 (3c-2-D4): the job and PR read the outcome fence makes, against Postgres. The ordering
 * (`prUpdatedAt` desc then `id`), the `source`/`prState` filter of the link query and the project fence are
 * exactly what a fake client can only imitate, so every row here is real.
 */
describePg('PrismaKnowledgeIndexRepository.describeJobs (PG)', () => {
  let prisma: PrismaService<PrismaClient>;
  let repo: PrismaKnowledgeIndexRepository;
  let tickets = 0;

  beforeAll(async () => {
    await resetDb();
    prisma = new PrismaService({ client: PrismaClient, clientOptions: { adapter: createPgAdapter(process.env.DATABASE_URL) } });
    await prisma.onModuleInit();
    repo = new PrismaKnowledgeIndexRepository(prisma);
  });

  afterAll(async () => {
    await prisma.onModuleDestroy();
  });

  /** A COMPLETED RUN job of its own project (its own repo), with the result PR url a search reports. */
  const seedJob = async (feature: string, resultPrUrl: string | null): Promise<{ jobId: string; projectId: string; repoId: string }> => {
    const { projectId, repoId, adminId } = await seedFleetBase(prisma.client);
    const job = await prisma.client.fleetJob.create({
      data: {
        projectId, repoId, ref: 'main', command: 'RUN', feature, profiles: [], selectorLabels: [],
        maxCostUsd: new Prisma.Decimal(1), requestedById: adminId, state: 'COMPLETED', resultPrUrl,
      },
    });
    return { jobId: job.id, projectId, repoId };
  };

  /** A ticket link of `jobId` — `source` and `prState` decide whether `describeJobs` may report it. */
  const seedLink = async (
    input: { projectId: string; jobId: string; prState: string | null; prUpdatedAt: Date; source?: string },
  ): Promise<string> => {
    tickets += 1;
    const ticket = await prisma.client.ticket.create({
      data: { projectId: input.projectId, number: tickets, type: 'TASK', title: `T${tickets}`, status: 'IN_PROGRESS' },
    });
    const url = `https://github.com/acme/app/pull/${tickets}`;
    await prisma.client.ticketLink.create({
      data: {
        ticketId: ticket.id, url, provider: 'github', linkType: 'pr', prNumber: tickets, externalRef: `acme/app#${tickets}`,
        source: input.source ?? 'fleet', jobId: input.jobId, prState: input.prState, prUpdatedAt: input.prUpdatedAt,
      },
    });
    return url;
  };

  it('AC-10: answers the newest fleet link state and the result PR url, and omits a job of another project', async () => {
    const mine = await seedJob('f1', 'https://github.com/acme/app/pull/9');
    const foreign = await seedJob('f2', 'https://github.com/acme/app/pull/10');
    await seedLink({ ...mine, prState: 'open', prUpdatedAt: new Date('2026-10-20T10:00:00.000Z') });
    await seedLink({ ...mine, prState: 'merged', prUpdatedAt: new Date('2026-10-21T10:00:00.000Z') });
    // Newer rows that the link query excludes: a `vcs` link and a fleet link without a PR state.
    await seedLink({ ...mine, prState: 'closed', prUpdatedAt: new Date('2026-10-22T10:00:00.000Z'), source: 'vcs' });
    await seedLink({ ...mine, prState: null, prUpdatedAt: new Date('2026-10-23T10:00:00.000Z') });
    await seedLink({ ...foreign, prState: 'merged', prUpdatedAt: new Date('2026-10-24T10:00:00.000Z') });

    const described = await repo.describeJobs(mine.projectId, [mine.jobId, foreign.jobId]);

    expect(described).toEqual([{
      jobId: mine.jobId, repoId: mine.repoId, feature: 'f1', state: 'COMPLETED',
      prUrl: 'https://github.com/acme/app/pull/9', prState: 'merged',
    }]);
  });

  it('answers a null prState for a job whose fleet links carry none, and no info for an unknown id', async () => {
    const mine = await seedJob('f3', null);
    await seedLink({ ...mine, prState: null, prUpdatedAt: new Date('2026-10-20T10:00:00.000Z') });

    expect(await repo.describeJobs(mine.projectId, [mine.jobId, 'missing'])).toEqual([
      { jobId: mine.jobId, repoId: mine.repoId, feature: 'f3', state: 'COMPLETED', prUrl: null, prState: null },
    ]);
  });
});
