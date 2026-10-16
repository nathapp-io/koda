/**
 * Fleet S5b knowledge index US-002 — hybrid repository-doc search over the chunk store (1c-c-D7).
 *
 * AC-1..AC-7: reciprocal rank fusion order and scores, the two predicates, the query-embedding
 * failure, hits of a deleted fleet repository, the path prefix and an empty project table.
 * The service has no Nest lifecycle, so every test uses direct instantiation (api-testing rule).
 */
import type { EmbeddingService } from '../../rag/embedding.service';
import type { KnowledgeChunkRow, KnowledgeChunkStore } from './knowledge-chunk-store';
import type { KnowledgeIndexService } from './knowledge-index.service';
import { KnowledgeSearchService, parseKnowledgeSearchInput } from './knowledge-search.service';

const PROJECT = 'p1';
const QUERY = 'broker';
const EMBEDDING = [0.5, 0.5];

function row(id: string, overrides: Partial<KnowledgeChunkRow> = {}): KnowledgeChunkRow {
  return {
    id,
    sourceId: `repo:r1:${id}.md`,
    provider: 'fake',
    repoId: 'r1',
    owner: 'o',
    name: 'n',
    path: `${id}.md`,
    sha: `sha-${id}`,
    blobSha: `blob-${id}`,
    title: `title ${id}`,
    headingPath: `title ${id}`,
    anchor: id,
    chunkIndex: 0,
    chunkCount: 1,
    abstract: `abstract ${id}`,
    text: `text ${id}`,
    ...overrides,
  };
}

const repoRef = (id: string) => ({
  id,
  projectId: PROJECT,
  provider: 'github' as const,
  owner: 'o',
  name: 'n',
  defaultBranch: 'main',
  githubInstallationId: null,
});

interface Harness {
  service: KnowledgeSearchService;
  store: {
    lexical: ReturnType<typeof vi.fn>;
    vector: ReturnType<typeof vi.fn>;
    readFile: ReturnType<typeof vi.fn>;
  };
  embedding: { embed: ReturnType<typeof vi.fn> };
  index: { listProjectRepos: ReturnType<typeof vi.fn> };
}

function harness(
  options: { lexical?: KnowledgeChunkRow[]; vector?: KnowledgeChunkRow[]; repos?: string[] } = {},
): Harness {
  const store = {
    lexical: vi.fn(async (_projectId: string, _query: string, _predicate: string, _limit: number) => options.lexical ?? []),
    vector: vi.fn(async (_projectId: string, _vector: number[], _predicate: string, _limit: number) => options.vector ?? []),
    readFile: vi.fn(async (_projectId: string, _sourceId: string) => [] as KnowledgeChunkRow[]),
  };
  const embedding = { embed: vi.fn(async (_text: string) => EMBEDDING) };
  const index = { listProjectRepos: vi.fn(async (_projectId: string) => (options.repos ?? ['r1']).map(repoRef)) };
  const service = new KnowledgeSearchService(
    store as unknown as KnowledgeChunkStore,
    embedding as unknown as EmbeddingService,
    index as unknown as KnowledgeIndexService,
  );
  return { service, store, embedding, index };
}

describe('KnowledgeSearchService', () => {
  it('AC-1: fuses lexical [a, b] and vector [b, c] into b, a, c with b scored 1/61 + 1/62', async () => {
    const { service } = harness({ lexical: [row('a'), row('b')], vector: [row('b'), row('c')] });

    const result = await service.search({ projectId: PROJECT, query: QUERY, limit: 20 });

    expect(result.hits.map((hit) => hit.path)).toEqual(['b.md', 'a.md', 'c.md']);
    expect(result.hits[0].score).toBe(1 / 61 + 1 / 62);
    expect(result.hits[1].score).toBe(1 / 61);
    expect(result.hits[2].score).toBe(1 / 62);
  });

  it('AC-2: asks the lexical leg for source = \'repo\' and the vector leg for source = \'repo\' AND provider != \'none\'', async () => {
    const { service, store } = harness();

    await service.search({ projectId: PROJECT, query: QUERY, limit: 20 });

    expect(store.lexical).toHaveBeenCalledWith(PROJECT, QUERY, "source = 'repo'", 50);
    expect(store.vector).toHaveBeenCalledWith(PROJECT, EMBEDDING, "source = 'repo' AND provider != 'none'", 50);
  });

  it('AC-3: both predicates end with the repo clause when repoId is given', async () => {
    const { service, store } = harness();

    await service.search({ projectId: PROJECT, query: QUERY, repoId: 'r1', limit: 20 });

    expect(store.lexical).toHaveBeenCalledWith(PROJECT, QUERY, "source = 'repo' AND source_id LIKE 'repo:r1:%'", 50);
    expect(store.vector).toHaveBeenCalledWith(
      PROJECT, EMBEDDING, "source = 'repo' AND provider != 'none' AND source_id LIKE 'repo:r1:%'", 50,
    );
  });

  it('AC-4: never calls the vector leg when the query embedding throws and answers the lexical hits with lexicalOnly', async () => {
    const { service, store, embedding } = harness({ lexical: [row('a'), row('b')] });
    embedding.embed.mockRejectedValue(new Error('ollama is down'));

    const result = await service.search({ projectId: PROJECT, query: QUERY, limit: 20 });

    expect(store.vector).not.toHaveBeenCalled();
    expect(result.lexicalOnly).toBe(true);
    expect(result.hits.map((hit) => hit.path)).toEqual(['a.md', 'b.md']);
    expect(result.hits[0].score).toBe(1 / 61);
    expect(result.hits[1].score).toBe(1 / 62);
  });

  it('AC-5: drops a hit whose repoId is not one of the project repositories', async () => {
    const { service, index } = harness({
      lexical: [row('a'), row('z', { repoId: 'r9' })],
      repos: ['r1'],
    });

    const result = await service.search({ projectId: PROJECT, query: QUERY, limit: 20 });

    expect(index.listProjectRepos).toHaveBeenCalledWith(PROJECT);
    expect(result.hits.map((hit) => hit.path)).toEqual(['a.md']);
  });

  it('AC-5: keeps the hits of a repository the project still owns', async () => {
    const { service } = harness({ lexical: [row('a', { repoId: 'r1' })], repos: ['r1', 'r2'] });

    const result = await service.search({ projectId: PROJECT, query: QUERY, limit: 20 });

    expect(result.hits.map((hit) => hit.repoId)).toEqual(['r1']);
  });

  it('AC-6: asks both legs for 200 rows, filters by pathPrefix and cuts to limit after the filter', async () => {
    const { service, store } = harness({
      lexical: [
        row('x', { path: 'docs/other/x.md' }),
        row('y', { path: 'docs/adr/y.md' }),
        row('z', { path: 'docs/adr/z.md' }),
      ],
    });

    const result = await service.search({ projectId: PROJECT, query: QUERY, pathPrefix: 'docs/adr/', limit: 1 });

    expect(store.lexical).toHaveBeenCalledWith(PROJECT, QUERY, "source = 'repo'", 200);
    expect(store.vector).toHaveBeenCalledWith(PROJECT, EMBEDDING, "source = 'repo' AND provider != 'none'", 200);
    // The higher ranked `x` is dropped by the prefix; the cut to `limit` happens after it.
    expect(result.hits.map((hit) => hit.path)).toEqual(['docs/adr/y.md']);
  });

  it('AC-7: answers empty with no hits for a project whose table holds no repo row', async () => {
    const { service } = harness({ lexical: [], vector: [] });

    const result = await service.search({ projectId: PROJECT, query: QUERY, limit: 20 });

    expect(result.empty).toBe(true);
    expect(result.hits).toEqual([]);
    expect(result.lexicalOnly).toBe(false);
  });

  it('AC-7: keeps the lexicalOnly boolean beside an empty result when the embedding also fails', async () => {
    const { service, embedding } = harness({ lexical: [], vector: [] });
    embedding.embed.mockRejectedValue(new Error('ollama is down'));

    const result = await service.search({ projectId: PROJECT, query: QUERY, limit: 20 });

    expect(result).toEqual({ lexicalOnly: true, empty: true, hits: [] });
  });

  it('AC-7: does not report empty when the table holds a repo row', async () => {
    const { service } = harness({ lexical: [row('a')] });

    const result = await service.search({ projectId: PROJECT, query: QUERY, limit: 20 });

    expect(result.empty).toBe(false);
  });

  it('breaks an equal fused score by row id ascending (1c-c-D7), not by leg order', async () => {
    // One row per leg, both at rank 1, so both score 1/61; the id decides, not the lexical leg first.
    const { service } = harness({ lexical: [row('b')], vector: [row('a')] });

    const result = await service.search({ projectId: PROJECT, query: QUERY, limit: 20 });

    expect(result.hits.map((hit) => hit.path)).toEqual(['a.md', 'b.md']);
    expect(result.hits.map((hit) => hit.score)).toEqual([1 / 61, 1 / 61]);
  });

  it('maps a row onto a hit with a 400 character snippet and the optional chunk status', async () => {
    const text = 'x'.repeat(500);
    const { service } = harness({
      lexical: [row('a', { text, status: 'deprecated', supersededBy: 'docs/adr/2.md' })],
    });

    const [hit] = (await service.search({ projectId: PROJECT, query: QUERY, limit: 20 })).hits;

    expect(hit).toEqual({
      repoId: 'r1', owner: 'o', name: 'n', path: 'a.md', sha: 'sha-a', anchor: 'a',
      headingPath: 'title a', title: 'title a', abstract: 'abstract a', snippet: 'x'.repeat(400),
      status: 'deprecated', supersededBy: 'docs/adr/2.md', score: 1 / 61,
    });
  });

  it('omits status and supersededBy on a chunk that carries neither', async () => {
    const { service } = harness({ lexical: [row('a')] });

    const [hit] = (await service.search({ projectId: PROJECT, query: QUERY, limit: 20 })).hits;

    expect(hit).not.toHaveProperty('status');
    expect(hit).not.toHaveProperty('supersededBy');
  });

  it('readDoc reads the file rows through the repo source id', async () => {
    const { service, store } = harness();

    await service.readDoc(PROJECT, 'r1', 'docs/adr/1.md');

    expect(store.readFile).toHaveBeenCalledWith(PROJECT, 'repo:r1:docs/adr/1.md');
  });
});

describe('parseKnowledgeSearchInput', () => {
  it.each([
    [{ query: 'broker' }, { query: 'broker', limit: 20 }],
    [{ query: 'broker', limit: 5 }, { query: 'broker', limit: 5 }],
    [{ query: 'broker', repo: 'o/n' }, { query: 'broker', repo: 'o/n', limit: 20 }],
    [{ query: 'broker', pathPrefix: 'docs/adr/' }, { query: 'broker', pathPrefix: 'docs/adr/', limit: 20 }],
    [{ query: 'x'.repeat(500) }, { query: 'x'.repeat(500), limit: 20 }],
  ])('accepts %j', (body, expected) => {
    expect(parseKnowledgeSearchInput(body)).toEqual({ ok: true, value: expected });
  });

  it.each([
    ['an empty body', {}],
    ['a missing query', { repo: 'o/n' }],
    ['a non-string query', { query: 5 }],
    ['an empty query', { query: '' }],
    ['a query over 500 characters', { query: 'x'.repeat(501) }],
    ['a repo without an owner', { query: 'q', repo: 'n' }],
    ['a repo without a name', { query: 'q', repo: 'o/' }],
    ['a repo with two slashes', { query: 'q', repo: 'o/n/x' }],
    ['a leading slash pathPrefix', { query: 'q', pathPrefix: '/docs' }],
    ['a traversing pathPrefix', { query: 'q', pathPrefix: '../x' }],
    ['an empty pathPrefix', { query: 'q', pathPrefix: '' }],
    ['a pathPrefix over 300 characters', { query: 'q', pathPrefix: 'x'.repeat(301) }],
    ['limit 0', { query: 'q', limit: 0 }],
    ['limit 51', { query: 'q', limit: 51 }],
    ['a fractional limit', { query: 'q', limit: 1.5 }],
    ['a string limit', { query: 'q', limit: '5' }],
  ])('rejects %s', (_label, body) => {
    const parsed = parseKnowledgeSearchInput(body);
    expect(parsed.ok).toBe(false);
  });

  it('names the rejected field', () => {
    const parsed = parseKnowledgeSearchInput({ query: 'q', pathPrefix: '../x' });
    expect(parsed).toEqual({ ok: false, reason: 'pathPrefix' });
  });
});
