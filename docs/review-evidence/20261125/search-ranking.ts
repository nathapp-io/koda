// Compare a live document against the same document with an obsolete corpus in a temporary LanceDB.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KnowledgeChunkStore } from '../../../apps/api/src/fleet/knowledge/knowledge-chunk-store';
import { KnowledgeSearchService } from '../../../apps/api/src/fleet/knowledge/knowledge-search.service';
import { LanceTableManager, type LanceRecord } from '../../../apps/api/src/rag/lance-table-manager';
import { ragConfig } from '../../../apps/api/src/config/rag.config';

async function main() {
  const dir = await mkdtemp(join(tmpdir(), 'koda-ranking-'));
  const embedding = { dimensions: 4, providerName: 'fixture', modelName: 'fixture', embed: async () => [1, 0, 0, 0] };
  const manager = new LanceTableManager({ ...ragConfig(), lancedbPath: dir, inMemoryOnly: false }, embedding as never);
  const store = new KnowledgeChunkStore(manager);
  const index = { listProjectRepos: async () => [{ id: 'current' }] };
  const service = new KnowledgeSearchService(store, embedding as never, index as never);
  const projectId = 'reviewranking';
  const query = { projectId, query: 'orchard', source: 'docs' as const, limit: 1 };
  async function put(repoId: string, count: number, content: string, vector: number[]) {
    const path = 'docs/gardening.md';
    const sourceId = `repo:${repoId}:${path}`;
    const rows: LanceRecord[] = Array.from({ length: count }, (_, chunkIndex) => ({
      id: `${sourceId}#${chunkIndex}`, source: 'repo', source_id: sourceId, content, vector,
      provider: 'fixture', model: 'fixture', created_at: '2026-11-25T00:00:00Z',
      metadata: JSON.stringify({
        repoId, path, chunkIndex, chunkCount: count, owner: 'review', name: repoId, title: 'Gardening',
        headingPath: '', anchor: '', abstract: content, text: content, sha: '1', blobSha: '1',
      }),
    }));
    await store.replaceFile(projectId, sourceId, rows);
  }
  try {
    await put('current', 1, 'orchard ' + 'planting '.repeat(45), [0, 1, 0, 0]);
    assert.equal((await service.search(query)).hits[0]?.repoId, 'current');
    await put('retired', 50, 'orchard orchard orchard', [1, 0, 0, 0]);
    const lexical = await store.lexical(projectId, query.query, "source = 'repo'", 51);
    const vector = await store.vector(projectId, await embedding.embed(), "source = 'repo'", 51);
    const ranks = [lexical, vector].map(rows => rows.findIndex(r => r.repoId === 'current') + 1);
    assert.deepEqual(ranks, [51, 51]);
    const all = await service.search(query);
    const scoped = await service.search({ ...query, repoId: 'current' });
    assert.equal(all.lexicalOnly, false);
    assert.equal(all.hits.length, 0);
    assert.equal(scoped.hits[0]?.repoId, 'current');
    console.log('07  native LanceDB: live row rank 51 in both legs; baseline=1, project-wide=0, repo-scoped=1');
  } finally {
    await manager.close();
    await rm(dir, { recursive: true, force: true });
  }
}

void main();
