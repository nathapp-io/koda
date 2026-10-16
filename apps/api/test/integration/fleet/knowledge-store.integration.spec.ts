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
import { PrismaService } from '@nathapp/nestjs-prisma';
import { PrismaClient } from '../../../src/generated/prisma/client';
import { createPgAdapter } from '../../../src/prisma/pg-adapter';
import type { IRagConfig } from '../../../src/config/rag.config';
import { LanceRecord, LanceTableManager } from '../../../src/rag/lance-table-manager';
import { EmbeddingService } from '../../../src/rag/embedding.service';
import { KnowledgeChunkStore } from '../../../src/fleet/knowledge/knowledge-chunk-store';
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
});
