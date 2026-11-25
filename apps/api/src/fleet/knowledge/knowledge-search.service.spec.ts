/**
 * Fleet S5b knowledge index US-002 — hybrid repository-doc search over the chunk store (1c-c-D7).
 *
 * AC-1..AC-7: reciprocal rank fusion order and scores, the two predicates, the query-embedding
 * failure, hits of a deleted fleet repository, the path prefix and an empty project table.
 * The service has no Nest lifecycle, so every test uses direct instantiation (api-testing rule).
 *
 * Fleet S5b knowledge outcomes US-005 adds the source filter, the outcome-hit enrichment and its
 * project fence (3c-2-D9) and `readOutcome` (3c-2-D9). Every 3c-1 case that pins a predicate or the
 * table read now says `source: 'docs'`: without it the default is the union of both sources.
 *
 * review-1125-remediation US-011 (finding 7) reads the project registry *before* either leg and puts
 * the eligible repository ids inside both storage predicates, so every predicate a leg is asked for
 * now carries the registry fence as well as the source clause.
 */
import type { ConfigType } from '@nestjs/config';
import { NotFoundAppException } from '@nathapp/nestjs-common';
import { ApprovalRouteGate } from '../../approvals/route/approval-route-gate';
import type { fleetConfig } from '../../config/fleet.config';
import type { ProjectContext } from '../../projects/project-context';
import type { EmbeddingService } from '../../rag/embedding.service';
import type { KnowledgeChunkRow, KnowledgeChunkStore } from './knowledge-chunk-store';
import type { KnowledgeJobInfo } from './knowledge-index.domain';
import type { KnowledgeIndexService } from './knowledge-index.service';
import { KnowledgeSearchService, parseKnowledgeSearchInput, type KnowledgeSource } from './knowledge-search.service';
import { ProjectKnowledgeController } from './project-knowledge.controller';

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

/** US-005: one job's current state, as the repository's `describeJobs` answers it. */
const job = (jobId: string, over: Partial<KnowledgeJobInfo> = {}): KnowledgeJobInfo => ({
  jobId, repoId: 'r1', feature: 'f', state: 'COMPLETED', prUrl: null, prState: null, ...over,
});

/** US-005: one outcome chunk row of job `jobId`, as the outcome pass writes it (3c-2-D6). */
function outcomeRow(jobId: string, id: string, over: Partial<KnowledgeChunkRow> = {}): KnowledgeChunkRow {
  return row(id, {
    sourceId: `outcome:r1:${jobId}:report`,
    path: 'feature-report.md',
    jobId,
    feature: 'f',
    outcomeKind: 'report',
    ...over,
  });
}

interface Harness {
  service: KnowledgeSearchService;
  store: {
    lexical: ReturnType<typeof vi.fn>;
    vector: ReturnType<typeof vi.fn>;
    readFile: ReturnType<typeof vi.fn>;
    hasRepoRows: ReturnType<typeof vi.fn>;
    hasOutcomeRows: ReturnType<typeof vi.fn>;
  };
  embedding: { embed: ReturnType<typeof vi.fn> };
  index: { listProjectRepos: ReturnType<typeof vi.fn>; describeJobs: ReturnType<typeof vi.fn> };
}

function harness(
  options: {
    lexical?: KnowledgeChunkRow[];
    vector?: KnowledgeChunkRow[];
    file?: KnowledgeChunkRow[];
    repos?: string[];
    repoRows?: boolean;
    outcomeRows?: boolean;
    /** The stub answer of `describeJobs`; by default every asked job is described. */
    jobs?: KnowledgeJobInfo[];
  } = {},
): Harness {
  const store = {
    lexical: vi.fn(async (_projectId: string, _query: string, _predicate: string, _limit: number) => options.lexical ?? []),
    vector: vi.fn(async (_projectId: string, _vector: number[], _predicate: string, _limit: number) => options.vector ?? []),
    readFile: vi.fn(async (_projectId: string, _sourceId: string) => options.file ?? ([] as KnowledgeChunkRow[])),
    hasRepoRows: vi.fn(async (_projectId: string) => options.repoRows ?? false),
    hasOutcomeRows: vi.fn(async (_projectId: string) => options.outcomeRows ?? false),
  };
  const embedding = { embed: vi.fn(async (_text: string) => EMBEDDING) };
  const index = {
    listProjectRepos: vi.fn(async (_projectId: string) => (options.repos ?? ['r1']).map(repoRef)),
    describeJobs: vi.fn(async (_projectId: string, jobIds: string[]) => options.jobs ?? jobIds.map((jobId) => job(jobId))),
  };
  const service = new KnowledgeSearchService(
    store as unknown as KnowledgeChunkStore,
    embedding as unknown as EmbeddingService,
    index as unknown as KnowledgeIndexService,
  );
  return { service, store, embedding, index };
}

/** The error a call throws, so a case can assert on the exception the route maps to a status. */
async function rejectionOf(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  throw new Error('expected the call to fail');
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

  it("US-005 AC-4: source 'docs' asks the lexical leg for source = 'repo' and the vector leg for source = 'repo' AND provider != 'none'", async () => {
    const { service, store } = harness();

    await service.search({ projectId: PROJECT, query: QUERY, source: 'docs', limit: 20 });

    // US-011: the registry fence is part of both predicates, here for the harness's one registered repository.
    expect(store.lexical).toHaveBeenCalledWith(PROJECT, QUERY, "source = 'repo' AND (source_id LIKE 'repo:r1:%')", 50);
    expect(store.vector).toHaveBeenCalledWith(
      PROJECT, EMBEDDING, "source = 'repo' AND provider != 'none' AND (source_id LIKE 'repo:r1:%')", 50,
    );
  });

  it('AC-3: both predicates end with the repo clause when repoId is given', async () => {
    const { service, store } = harness();

    await service.search({ projectId: PROJECT, query: QUERY, source: 'docs', repoId: 'r1', limit: 20 });

    expect(store.lexical).toHaveBeenCalledWith(PROJECT, QUERY, "source = 'repo' AND (source_id LIKE 'repo:r1:%')", 50);
    expect(store.vector).toHaveBeenCalledWith(
      PROJECT, EMBEDDING, "source = 'repo' AND provider != 'none' AND (source_id LIKE 'repo:r1:%')", 50,
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

  it('drops a repository retired during retrieval before filling the hit limit', async () => {
    const repos = ['r1', 'r2'];
    const { service, embedding } = harness({
      repos,
      lexical: [row('retired', { repoId: 'r1' }), row('current', { repoId: 'r2' })],
    });
    embedding.embed.mockImplementationOnce(async () => {
      repos.shift();
      return EMBEDDING;
    });

    const result = await service.search({ projectId: PROJECT, query: QUERY, limit: 1 });

    expect(result.hits.map((hit) => hit.repoId)).toEqual(['r2']);
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

    const result = await service.search({ projectId: PROJECT, query: QUERY, source: 'docs', pathPrefix: 'docs/adr/', limit: 1 });

    expect(store.lexical).toHaveBeenCalledWith(PROJECT, QUERY, "source = 'repo' AND (source_id LIKE 'repo:r1:%')", 200);
    expect(store.vector).toHaveBeenCalledWith(
      PROJECT, EMBEDDING, "source = 'repo' AND provider != 'none' AND (source_id LIKE 'repo:r1:%')", 200,
    );
    // The higher ranked `x` is dropped by the prefix; the cut to `limit` happens after it.
    expect(result.hits.map((hit) => hit.path)).toEqual(['docs/adr/y.md']);
  });

  it('AC-7: answers empty with no hits for a project whose table holds no repo row', async () => {
    const { service } = harness({ lexical: [], vector: [] });

    const result = await service.search({ projectId: PROJECT, query: QUERY, source: 'docs', limit: 20 });

    expect(result.empty).toBe(true);
    expect(result.hits).toEqual([]);
    expect(result.lexicalOnly).toBe(false);
  });

  it('AC-7: keeps the lexicalOnly boolean beside an empty result when the embedding also fails', async () => {
    const { service, embedding } = harness({ lexical: [], vector: [] });
    embedding.embed.mockRejectedValue(new Error('ollama is down'));

    const result = await service.search({ projectId: PROJECT, query: QUERY, source: 'docs', limit: 20 });

    expect(result).toEqual({ lexicalOnly: true, empty: true, hits: [] });
  });

  it('AC-7: does not report empty when the table holds a repo row', async () => {
    const { service } = harness({ lexical: [row('a')] });

    const result = await service.search({ projectId: PROJECT, query: QUERY, limit: 20 });

    expect(result.empty).toBe(false);
  });

  it('AC-7: reads empty off the table, not off the legs, when the embedding is down and the lexical query misses', async () => {
    const { service, embedding, store } = harness({ lexical: [], vector: [], repoRows: true });
    embedding.embed.mockRejectedValue(new Error('ollama is down'));

    const result = await service.search({ projectId: PROJECT, query: QUERY, source: 'docs', limit: 20 });

    expect(store.hasRepoRows).toHaveBeenCalledWith(PROJECT);
    expect(result).toEqual({ lexicalOnly: true, empty: false, hits: [] });
  });

  it('AC-7: does not report empty when every stored row is provider: none and the lexical query misses', async () => {
    // The vector leg's `provider != 'none'` clause answers nothing and the lexical leg matched nothing, yet the
    // table holds repository chunks: the project is indexed, the query just missed.
    const { service } = harness({ lexical: [], vector: [], repoRows: true });

    const result = await service.search({ projectId: PROJECT, query: QUERY, source: 'docs', limit: 20 });

    expect(result).toEqual({ lexicalOnly: false, empty: false, hits: [] });
  });

  it('AC-7: does not ask the table whether rows exist when a leg already answered a hit', async () => {
    const { service, store } = harness({ lexical: [row('a')] });

    await service.search({ projectId: PROJECT, query: QUERY, limit: 20 });

    expect(store.hasRepoRows).not.toHaveBeenCalled();
    expect(store.hasOutcomeRows).not.toHaveBeenCalled();
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
      status: 'deprecated', supersededBy: 'docs/adr/2.md', source: 'repo', score: 1 / 61,
    });
  });

  it('omits status and supersededBy on a chunk that carries neither', async () => {
    const { service } = harness({ lexical: [row('a')] });

    const [hit] = (await service.search({ projectId: PROJECT, query: QUERY, limit: 20 })).hits;

    expect(hit).not.toHaveProperty('status');
    expect(hit).not.toHaveProperty('supersededBy');
  });

  it('carries no outcome field on a doc hit, so the two sources are distinguishable by shape', async () => {
    const { service } = harness({ lexical: [row('a')] });

    const [hit] = (await service.search({ projectId: PROJECT, query: QUERY, limit: 20 })).hits;

    expect(hit.source).toBe('repo');
    for (const field of ['jobId', 'feature', 'outcomeKind', 'jobState', 'prState', 'prUrl']) {
      expect(hit, field).not.toHaveProperty(field);
    }
  });

  it('readDoc reads the file rows through the repo source id', async () => {
    const { service, store } = harness();

    await service.readDoc(PROJECT, 'r1', 'docs/adr/1.md');

    expect(store.readFile).toHaveBeenCalledWith(PROJECT, 'repo:r1:docs/adr/1.md');
  });

  // ── Fleet S5b US-005 (3c-2-D9): the source filter, the outcome hit and its fence ─────────────────────

  it("US-005 AC-1: source 'outcomes' asks both legs for the outcome source only", async () => {
    const { service, store } = harness();

    await service.search({ projectId: PROJECT, query: QUERY, source: 'outcomes', limit: 20 });

    expect(store.lexical).toHaveBeenCalledWith(PROJECT, QUERY, "source = 'outcome' AND (source_id LIKE 'outcome:r1:%')", 50);
    expect(store.vector).toHaveBeenCalledWith(
      PROJECT, EMBEDDING, "source = 'outcome' AND provider != 'none' AND (source_id LIKE 'outcome:r1:%')", 50,
    );
  });

  it('US-005 AC-2: no source asks both legs for the union of the two sources', async () => {
    const { service, store } = harness();

    await service.search({ projectId: PROJECT, query: QUERY, limit: 20 });

    expect(store.lexical).toHaveBeenCalledWith(
      PROJECT, QUERY,
      "(source = 'repo' AND (source_id LIKE 'repo:r1:%')) OR (source = 'outcome' AND (source_id LIKE 'outcome:r1:%'))",
      50,
    );
    expect(store.vector).toHaveBeenCalledWith(
      PROJECT, EMBEDDING,
      "(source = 'repo' AND provider != 'none' AND (source_id LIKE 'repo:r1:%'))"
        + " OR (source = 'outcome' AND provider != 'none' AND (source_id LIKE 'outcome:r1:%'))",
      50,
    );
  });

  it("US-005 AC-2: source 'all' is the same union as the default", async () => {
    const { service, store } = harness();

    await service.search({ projectId: PROJECT, query: QUERY, source: 'all', limit: 20 });

    expect(store.lexical).toHaveBeenCalledWith(
      PROJECT, QUERY,
      "(source = 'repo' AND (source_id LIKE 'repo:r1:%')) OR (source = 'outcome' AND (source_id LIKE 'outcome:r1:%'))",
      50,
    );
    expect(store.vector).toHaveBeenCalledWith(
      PROJECT, EMBEDDING,
      "(source = 'repo' AND provider != 'none' AND (source_id LIKE 'repo:r1:%'))"
        + " OR (source = 'outcome' AND provider != 'none' AND (source_id LIKE 'outcome:r1:%'))",
      50,
    );
  });

  it("US-005 AC-3: source 'outcomes' with repoId r1 narrows both legs to the outcome source ids of r1", async () => {
    const { service, store } = harness();

    await service.search({ projectId: PROJECT, query: QUERY, source: 'outcomes', repoId: 'r1', limit: 20 });

    expect(store.lexical).toHaveBeenCalledWith(PROJECT, QUERY, "source = 'outcome' AND (source_id LIKE 'outcome:r1:%')", 50);
    expect(store.vector).toHaveBeenCalledWith(
      PROJECT, EMBEDDING, "source = 'outcome' AND provider != 'none' AND (source_id LIKE 'outcome:r1:%')", 50,
    );
  });

  it('US-005 AC-5: enriches an outcome hit from the described job and marks a doc hit source repo', async () => {
    const { service, index } = harness({
      lexical: [outcomeRow('j1', 'o1'), row('a')],
      jobs: [job('j1', { state: 'ESCALATED', prState: 'merged', prUrl: 'https://github.com/o/n/pull/9' })],
    });

    const result = await service.search({ projectId: PROJECT, query: QUERY, limit: 20 });

    expect(index.describeJobs).toHaveBeenCalledWith(PROJECT, ['j1']);
    const outcome = result.hits.find((hit) => hit.source === 'outcome');
    expect(outcome).toMatchObject({
      source: 'outcome', jobId: 'j1', feature: 'f', outcomeKind: 'report',
      jobState: 'ESCALATED', prState: 'merged', prUrl: 'https://github.com/o/n/pull/9',
    });
    expect(result.hits.find((hit) => hit.path === 'a.md')).toMatchObject({ source: 'repo' });
  });

  it('US-005 AC-5: an outcome hit carries a null prState and prUrl when the job has no pull request', async () => {
    const { service } = harness({ lexical: [outcomeRow('j1', 'o1')], jobs: [job('j1', { prState: null, prUrl: null })] });

    const [hit] = (await service.search({ projectId: PROJECT, query: QUERY, limit: 20 })).hits;

    expect(hit).toMatchObject({ source: 'outcome', prState: null, prUrl: null });
  });

  it('US-005 AC-6: drops an outcome hit whose job the project does not have', async () => {
    const { service, index } = harness({
      lexical: [outcomeRow('j1', 'o1'), outcomeRow('foreign', 'o2'), outcomeRow('gone', 'o3')],
      jobs: [job('j1')],
    });

    const result = await service.search({ projectId: PROJECT, query: QUERY, limit: 20 });

    // Foreign and deleted jobs are the same thing here: the repository saw the ids and described only one.
    expect(index.describeJobs).toHaveBeenCalledWith(PROJECT, ['j1', 'foreign', 'gone']);
    expect(result.hits.map((hit) => hit.jobId)).toEqual(['j1']);
  });

  it('US-005 AC-7: never asks for jobs when every hit is a doc hit', async () => {
    const { service, index } = harness({ lexical: [row('a'), row('b')] });

    const result = await service.search({ projectId: PROJECT, query: QUERY, source: 'all', limit: 20 });

    expect(result.hits.map((hit) => hit.source)).toEqual(['repo', 'repo']);
    expect(index.describeJobs).not.toHaveBeenCalled();
  });

  it("US-005 AC-8: source 'all' with a pathPrefix drops the outcome hits and answers the prefixed doc hits", async () => {
    const { service, index, store } = harness({
      lexical: [
        outcomeRow('j1', 'o1', { path: 'docs/run-notes.md' }),
        row('a', { path: 'docs/a.md' }),
        row('b', { path: 'other/b.md' }),
      ],
    });

    const result = await service.search({ projectId: PROJECT, query: QUERY, source: 'all', pathPrefix: 'docs/', limit: 20 });

    expect(result.hits.map((hit) => hit.path)).toEqual(['docs/a.md']);
    expect(result.hits.every((hit) => hit.source === 'repo')).toBe(true);
    // The outcome hits are dropped before the fence, so no job is described for a prefixed search.
    expect(index.describeJobs).not.toHaveBeenCalled();
    expect(store.lexical).toHaveBeenCalledWith(
      PROJECT, QUERY,
      "(source = 'repo' AND (source_id LIKE 'repo:r1:%')) OR (source = 'outcome' AND (source_id LIKE 'outcome:r1:%'))",
      200,
    );
  });

  it("US-005 AC-9: source 'outcomes' on a table with no outcome row is empty and asks only the outcome table", async () => {
    const { service, store } = harness({ lexical: [], vector: [], repoRows: true, outcomeRows: false });

    const result = await service.search({ projectId: PROJECT, query: QUERY, source: 'outcomes', limit: 20 });

    expect(result.empty).toBe(true);
    expect(store.hasOutcomeRows).toHaveBeenCalledWith(PROJECT);
    expect(store.hasRepoRows).not.toHaveBeenCalled();
  });

  it("US-005 AC-9: source 'outcomes' is not empty while the table holds an outcome row", async () => {
    const { service } = harness({ lexical: [], vector: [], repoRows: true, outcomeRows: true });

    const result = await service.search({ projectId: PROJECT, query: QUERY, source: 'outcomes', limit: 20 });

    expect(result.empty).toBe(false);
  });

  it("US-005 AC-9: source 'all' is not empty when only the outcome rows exist", async () => {
    const { service, store } = harness({ lexical: [], vector: [], repoRows: false, outcomeRows: true });

    const result = await service.search({ projectId: PROJECT, query: QUERY, limit: 20 });

    expect(result.empty).toBe(false);
    expect(store.hasRepoRows).toHaveBeenCalledWith(PROJECT);
    expect(store.hasOutcomeRows).toHaveBeenCalledWith(PROJECT);
  });

  it("US-005 AC-9: source 'all' is empty when neither source has a row", async () => {
    const { service } = harness({ lexical: [], vector: [], repoRows: false, outcomeRows: false });

    const result = await service.search({ projectId: PROJECT, query: QUERY, limit: 20 });

    expect(result.empty).toBe(true);
  });

  it('US-005: cuts to limit after the outcome fence, so a dropped outcome hit does not consume the answer', async () => {
    const { service } = harness({
      lexical: [outcomeRow('gone', 'o1'), row('a'), row('b')],
      jobs: [],
    });

    const result = await service.search({ projectId: PROJECT, query: QUERY, limit: 1 });

    expect(result.hits.map((hit) => hit.path)).toEqual(['a.md']);
  });
});

/**
 * review-1125-remediation US-011 (finding 7): the project registry is read *before* either leg, and the
 * eligible repository ids go inside both storage predicates, so a repository the project no longer owns can
 * never spend a leg's row cap. The store double answers whatever it is handed (it does not evaluate a
 * predicate), so each case pins the predicate a leg is asked for *and* the hits that survive the fence the
 * service applies to the rows a leg answered.
 */
describe('KnowledgeSearchService registry fence (US-011)', () => {
  it('AC-4: an empty project registry answers zero eligible hits and asks no leg', async () => {
    const { service, store } = harness({ repos: [], lexical: [row('a')], vector: [row('b')] });

    const result = await service.search({ projectId: PROJECT, query: QUERY, source: 'docs', limit: 20 });

    expect(result.hits).toEqual([]);
    // Nothing is eligible, so there is no predicate to widen: neither leg is asked at all.
    expect(store.lexical).not.toHaveBeenCalled();
    expect(store.vector).not.toHaveBeenCalled();
  });

  it('AC-5: an explicit retired repoId answers zero eligible hits and asks no leg', async () => {
    const { service, store } = harness({ repos: ['r1'], lexical: [row('a')] });

    const result = await service.search({ projectId: PROJECT, query: QUERY, source: 'docs', repoId: 'retired', limit: 20 });

    expect(result.hits).toEqual([]);
    expect(store.lexical).not.toHaveBeenCalled();
    expect(store.vector).not.toHaveBeenCalled();
  });

  it('AC-6: an explicit repoId of another project answers zero eligible hits and asks no leg', async () => {
    // The store would answer a row of that repository; the fence is what keeps it out.
    const foreign = row('foreign', { repoId: 'other-project-repo', sourceId: 'repo:other-project-repo:foreign.md' });
    const { service, store } = harness({ repos: ['r1'], lexical: [row('a'), foreign] });

    const result = await service.search({ projectId: PROJECT, query: QUERY, source: 'docs', repoId: 'other-project-repo', limit: 20 });

    expect(result.hits).toEqual([]);
    expect(store.lexical).not.toHaveBeenCalled();
  });

  it('AC-7: an explicit live registered repoId restricts both legs to that repository', async () => {
    const { service, store } = harness({
      repos: ['r1', 'r2'],
      lexical: [row('a'), row('b', { repoId: 'r2', sourceId: 'repo:r2:b.md' })],
    });

    const result = await service.search({ projectId: PROJECT, query: QUERY, source: 'docs', repoId: 'r1', limit: 20 });

    expect(store.lexical).toHaveBeenCalledWith(PROJECT, QUERY, "source = 'repo' AND (source_id LIKE 'repo:r1:%')", 50);
    expect(store.vector).toHaveBeenCalledWith(
      PROJECT, EMBEDDING, "source = 'repo' AND provider != 'none' AND (source_id LIKE 'repo:r1:%')", 50,
    );
    expect(result.hits.map((hit) => hit.repoId)).toEqual(['r1']);
  });

  it('AC-7: a project-wide search fences both legs to every registered repository', async () => {
    const { service, store } = harness({ repos: ['r1', 'r2'] });

    await service.search({ projectId: PROJECT, query: QUERY, source: 'docs', limit: 20 });

    expect(store.lexical).toHaveBeenCalledWith(
      PROJECT, QUERY, "source = 'repo' AND (source_id LIKE 'repo:r1:%' OR source_id LIKE 'repo:r2:%')", 50,
    );
    expect(store.vector).toHaveBeenCalledWith(
      PROJECT, EMBEDDING,
      "source = 'repo' AND provider != 'none' AND (source_id LIKE 'repo:r1:%' OR source_id LIKE 'repo:r2:%')", 50,
    );
  });

  it.each([
    [
      'docs', [row('a')], ['repo'],
      "source = 'repo' AND (source_id LIKE 'repo:r1:%')",
      "source = 'repo' AND provider != 'none' AND (source_id LIKE 'repo:r1:%')",
    ],
    [
      'outcomes', [outcomeRow('j1', 'o1')], ['outcome'],
      "source = 'outcome' AND (source_id LIKE 'outcome:r1:%')",
      "source = 'outcome' AND provider != 'none' AND (source_id LIKE 'outcome:r1:%')",
    ],
    [
      'all', [row('a'), outcomeRow('j1', 'o1')], ['repo', 'outcome'],
      "(source = 'repo' AND (source_id LIKE 'repo:r1:%')) OR (source = 'outcome' AND (source_id LIKE 'outcome:r1:%'))",
      "(source = 'repo' AND provider != 'none' AND (source_id LIKE 'repo:r1:%'))"
        + " OR (source = 'outcome' AND provider != 'none' AND (source_id LIKE 'outcome:r1:%'))",
    ],
  ] as Array<[KnowledgeSource, KnowledgeChunkRow[], string[], string, string]>)(
    'AC-9: source %s answers only the source families its legs were asked for on registered repositories',
    async (source, rows, expected, lexicalPredicate, vectorPredicate) => {
      const { service, store } = harness({ repos: ['r1'], lexical: rows, vector: rows });

      const result = await service.search({ projectId: PROJECT, query: QUERY, source, limit: 20 });

      expect(result.hits.map((hit) => hit.source)).toEqual(expected);
      // The legs carry the source clause and the registry fence together, never one without the other.
      expect(store.lexical).toHaveBeenCalledWith(PROJECT, QUERY, lexicalPredicate, 50);
      expect(store.vector).toHaveBeenCalledWith(PROJECT, EMBEDDING, vectorPredicate, 50);
    },
  );

  it.each(['docs', 'outcomes', 'all'] as KnowledgeSource[])(
    'AC-10: source %s with a pathPrefix answers only the repository-document hits under the prefix and no outcome hit',
    async (source) => {
      const { service, store, index } = harness({
        repos: ['r1'],
        lexical: [
          outcomeRow('j1', 'o1', { path: 'docs/run-notes.md' }),
          row('a', { path: 'docs/adr/a.md' }),
          row('b', { path: 'other/b.md' }),
        ],
      });

      const result = await service.search({ projectId: PROJECT, query: QUERY, source, pathPrefix: 'docs/adr/', limit: 20 });

      expect(result.hits.map((hit) => `${hit.source}:${hit.path}`)).toEqual(['repo:docs/adr/a.md']);
      // The wider page is still asked for, with the registry fence on it.
      const namespace = source === 'outcomes' ? 'outcome' : 'repo';
      expect(store.lexical).toHaveBeenCalledWith(
        PROJECT, QUERY, expect.stringContaining(`source_id LIKE '${namespace}:r1:%'`), 200,
      );
      expect(index.describeJobs).not.toHaveBeenCalled();
    },
  );

  it('AC-11: no outcome hit survives for a job describeJobs omits, and the reachable job keeps its hit', async () => {
    const { service, index } = harness({
      repos: ['r1', 'r2'],
      lexical: [outcomeRow('j1', 'o1'), outcomeRow('gone', 'o2'), row('a', { repoId: 'r2', sourceId: 'repo:r2:a.md' })],
      jobs: [job('j1')],
    });

    const result = await service.search({ projectId: PROJECT, query: QUERY, source: 'all', limit: 20 });

    expect(index.describeJobs).toHaveBeenCalledWith(PROJECT, ['j1', 'gone']);
    expect(result.hits.map((hit) => `${hit.source}:${hit.path}`).sort()).toEqual([
      'outcome:feature-report.md', 'repo:a.md',
    ]);
    expect(result.hits.filter((hit) => hit.source === 'outcome').map((hit) => hit.jobId)).toEqual(['j1']);
  });

  it('AC-12: an embedding failure answers the registered repositories’ lexical hits with lexicalOnly', async () => {
    const { service, store, embedding } = harness({
      repos: ['r1'],
      lexical: [row('a'), row('b', { repoId: 'retired', sourceId: 'repo:retired:b.md' })],
    });
    embedding.embed.mockRejectedValue(new Error('ollama is down'));

    const result = await service.search({ projectId: PROJECT, query: QUERY, source: 'docs', limit: 20 });

    expect(store.vector).not.toHaveBeenCalled();
    // The surviving leg is asked the same fenced query, so the fallback cannot answer a retired repository.
    expect(store.lexical).toHaveBeenCalledWith(PROJECT, QUERY, "source = 'repo' AND (source_id LIKE 'repo:r1:%')", 50);
    expect(result.lexicalOnly).toBe(true);
    expect(result.hits.map((hit) => hit.path)).toEqual(['a.md']);
  });

  it.each([
    ['docs', { repoRows: false, outcomeRows: false }, true],
    ['docs', { repoRows: true, outcomeRows: false }, false],
    ['outcomes', { repoRows: false, outcomeRows: false }, true],
    ['outcomes', { repoRows: true, outcomeRows: true }, false],
    ['all', { repoRows: false, outcomeRows: false }, true],
    ['all', { repoRows: true, outcomeRows: false }, false],
    ['all', { repoRows: false, outcomeRows: true }, false],
  ] as Array<[KnowledgeSource, { repoRows: boolean; outcomeRows: boolean }, boolean]>)(
    'AC-13: source %s answers empty=%s off the stored rows of that source family when no leg matches',
    async (source, rows, expected) => {
      const { service } = harness({ repos: ['r1'], lexical: [], vector: [], ...rows });

      const result = await service.search({ projectId: PROJECT, query: QUERY, source, limit: 20 });

      expect(result.hits).toEqual([]);
      expect(result.empty).toBe(expected);
    },
  );

  it('AC-13: an empty registry over a table with stored rows is not empty — empty counts rows, not eligible hits', async () => {
    const { service, store } = harness({ repos: [], lexical: [row('a')], vector: [], repoRows: true });

    const result = await service.search({ projectId: PROJECT, query: QUERY, source: 'docs', limit: 20 });

    // The row the store would have answered belongs to no registered repository, so it is never asked for …
    expect(store.lexical).not.toHaveBeenCalled();
    // … and the project's table still holds a repository row, so the answer is "no eligible hit", not "empty".
    expect(result).toEqual({ lexicalOnly: false, empty: false, hits: [] });
  });
});

/**
 * US-011 AC-8: the REST caller keeps its not-found response. The route resolves `owner/name` through the index
 * service before the search runs, so an unknown — or retired, or foreign — repository is `knowledge.repoNotFound`
 * (404) and no leg is ever asked. Driven over the *real* service, because the fence the route now relies on is the
 * service's own.
 */
describe('ProjectKnowledgeController.search over the real service (US-011)', () => {
  const CTX: ProjectContext = { project: { id: PROJECT, slug: 'koda' } };

  function controller(service: KnowledgeSearchService, resolve: unknown): ProjectKnowledgeController {
    return new ProjectKnowledgeController(
      service,
      { resolveProjectRepo: vi.fn(async () => resolve) } as unknown as KnowledgeIndexService,
      { knowledgeIndexEnabled: true } as unknown as ConfigType<typeof fleetConfig>,
      { run: vi.fn() } as unknown as ApprovalRouteGate,
    );
  }

  it('AC-8: an unknown owner/name throws knowledge.repoNotFound and never searches', async () => {
    const { service, store } = harness({ repos: ['r1'], lexical: [row('a')] });

    const error = await rejectionOf(() => controller(service, null).search({ query: QUERY, repo: 'o/missing', limit: 20 }, CTX));

    expect(error).toBeInstanceOf(NotFoundAppException);
    expect((error as NotFoundAppException).getStatus()).toBe(404);
    expect((error as NotFoundAppException).prefix).toBe('knowledge.repoNotFound');
    expect(store.lexical).not.toHaveBeenCalled();
    expect(store.vector).not.toHaveBeenCalled();
  });
});

describe('KnowledgeSearchService.readOutcome (US-005)', () => {
  it('US-005 AC-11: reads the report outcome file through outcome:<repoId>:<jobId>:report', async () => {
    const rows = [outcomeRow('j1', 'o1')];
    const { service, store } = harness({ file: rows, jobs: [job('j1')] });

    const found = await service.readOutcome(PROJECT, 'j1', 'feature-report.md');

    expect(store.readFile).toHaveBeenCalledWith(PROJECT, 'outcome:r1:j1:report');
    expect(found).toEqual(rows);
  });

  it('US-005 AC-11: reads the decisions outcome file through outcome:<repoId>:<jobId>:decisions', async () => {
    const { service, store, index } = harness({ jobs: [job('j1')] });

    await service.readOutcome(PROJECT, 'j1', 'decisions.jsonl');

    expect(index.describeJobs).toHaveBeenCalledWith(PROJECT, ['j1']);
    expect(store.readFile).toHaveBeenCalledWith(PROJECT, 'outcome:r1:j1:decisions');
  });

  it('US-005 AC-11: answers no rows for a job the project does not have and reads nothing', async () => {
    const { service, store } = harness({ file: [outcomeRow('j1', 'o1')], jobs: [] });

    expect(await service.readOutcome(PROJECT, 'j1', 'decisions.jsonl')).toEqual([]);
    expect(store.readFile).not.toHaveBeenCalled();
  });

  it('US-005 AC-11: answers no rows for an outcome file that is not one of the two, without reading', async () => {
    const { service, store } = harness({ file: [outcomeRow('j1', 'o1')], jobs: [job('j1')] });

    expect(await service.readOutcome(PROJECT, 'j1', 'prd.json')).toEqual([]);
    expect(store.readFile).not.toHaveBeenCalled();
  });

  /**
   * M1 (branch review): the path comes from an untrusted citation, so the file lookup must be an own-key one.
   * With an object literal, `OUTCOME_KIND_BY_PATH['__proto__']` answered `Object.prototype` (truthy) and
   * `['constructor']` a function, so those names fell through to a `describeJobs` and a chunk-store read that
   * should never happen.
   */
  it.each(['__proto__', 'constructor', 'prototype', 'toString', 'hasOwnProperty'])(
    'M1: answers no rows for the inherited name %s and reads nothing',
    async (path) => {
      const { service, store, index } = harness({ file: [outcomeRow('j1', 'o1')], jobs: [job('j1')] });

      expect(await service.readOutcome(PROJECT, 'j1', path)).toEqual([]);
      expect(index.describeJobs).not.toHaveBeenCalled();
      expect(store.readFile).not.toHaveBeenCalled();
    },
  );
});

describe('parseKnowledgeSearchInput', () => {
  it.each([
    [{ query: 'broker' }, { query: 'broker', limit: 20 }],
    [{ query: 'broker', limit: 5 }, { query: 'broker', limit: 5 }],
    [{ query: 'broker', repo: 'o/n' }, { query: 'broker', repo: 'o/n', limit: 20 }],
    [{ query: 'broker', pathPrefix: 'docs/adr/' }, { query: 'broker', pathPrefix: 'docs/adr/', limit: 20 }],
    [{ query: 'broker', source: 'docs' }, { query: 'broker', source: 'docs', limit: 20 }],
    [{ query: 'broker', source: 'outcomes' }, { query: 'broker', source: 'outcomes', limit: 20 }],
    [{ query: 'broker', source: 'all' }, { query: 'broker', source: 'all', limit: 20 }],
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
    ['an unknown source', { query: 'q', source: 'code' }],
    ['a non-string source', { query: 'q', source: 5 }],
  ])('rejects %s', (_label, body) => {
    const parsed = parseKnowledgeSearchInput(body);
    expect(parsed.ok).toBe(false);
  });

  it('names the rejected field', () => {
    const parsed = parseKnowledgeSearchInput({ query: 'q', pathPrefix: '../x' });
    expect(parsed).toEqual({ ok: false, reason: 'pathPrefix' });
  });

  it('US-005: names source as the rejected field', () => {
    const parsed = parseKnowledgeSearchInput({ query: 'q', source: 'code' });
    expect(parsed).toEqual({ ok: false, reason: 'source' });
  });
});
