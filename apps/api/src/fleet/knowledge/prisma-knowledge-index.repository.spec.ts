/**
 * Fleet S5b knowledge index US-004/AC-5 — the file-state read must enumerate *every* persisted row, not the
 * first corpus cap worth of them: a pass writes new files before it deletes obsolete ones, so an interrupted
 * pass leaves more rows than the 2000-file corpus cap, and a capped read would hide the obsolete rows from
 * the cleanup step (their chunks staying searchable forever).
 *
 * The Prisma client is faked here so this runs without a database; the PG round-trip lives in
 * test/integration/fleet/knowledge-store.integration.spec.ts.
 */
import type { PrismaService } from '@nathapp/nestjs-prisma';
import type { PrismaClient } from '../../generated/prisma/client';
import { MAX_KNOWLEDGE_FILES } from './knowledge-allowlist';
import { PrismaKnowledgeIndexRepository } from './prisma-knowledge-index.repository';

interface FileRow {
  repoId: string;
  path: string;
  blobSha: string;
  chunkCount: number;
  unembeddedCount: number;
}

interface FindManyArgs {
  where: { repoId: string; path?: { gt: string } };
  orderBy: { path: 'asc' };
  take: number;
}

/** A `knowledgeRepoFile` table stub that honours the `path > cursor` keyset and the `take` of a page read. */
function fakeClient(paths: string[]): { client: unknown; findMany: ReturnType<typeof vi.fn>; calls: FindManyArgs[] } {
  const rows: FileRow[] = paths.map((path) => ({ repoId: 'r1', path, blobSha: 'sha', chunkCount: 1, unembeddedCount: 0 }));
  const calls: FindManyArgs[] = [];
  const findMany = vi.fn(async (args: FindManyArgs) => {
    calls.push(args);
    const after = args.where.path?.gt;
    return rows
      .filter((row) => after === undefined || row.path > after)
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
      .slice(0, args.take);
  });
  return { client: { knowledgeRepoFile: { findMany } }, findMany, calls };
}

function build(paths: string[]): { repo: PrismaKnowledgeIndexRepository; findMany: ReturnType<typeof vi.fn>; calls: FindManyArgs[] } {
  const { client, findMany, calls } = fakeClient(paths);
  const repo = new PrismaKnowledgeIndexRepository({ client } as unknown as PrismaService<PrismaClient>);
  return { repo, findMany, calls };
}

const pagePaths = (count: number): string[] =>
  Array.from({ length: count }, (_, i) => `docs/${String(i).padStart(5, '0')}.md`);

describe('PrismaKnowledgeIndexRepository.listFiles', () => {
  it('reads one page when the repository fits the corpus cap', async () => {
    const { repo, findMany } = build(pagePaths(3));

    const files = await repo.listFiles('r1');

    expect(files.map((file) => file.path)).toEqual(['docs/00000.md', 'docs/00001.md', 'docs/00002.md']);
    expect(findMany).toHaveBeenCalledTimes(1);
    expect(files[0]).toEqual({ repoId: 'r1', path: 'docs/00000.md', blobSha: 'sha', chunkCount: 1, unembeddedCount: 0 });
  });

  it('enumerates every row past the 2000-file corpus cap (US-004/AC-5)', async () => {
    const paths = pagePaths(MAX_KNOWLEDGE_FILES + 1);
    const { repo, findMany } = build(paths);

    const files = await repo.listFiles('r1');

    // A `take: 2000` read answers 2000 of them and hides the rest from the cleanup step.
    expect(files).toHaveLength(MAX_KNOWLEDGE_FILES + 1);
    expect(files.map((file) => file.path)).toEqual(paths);
    expect(findMany).toHaveBeenCalledTimes(2);
  });

  it('walks the pages with a path keyset and ends on a short page', async () => {
    const paths = pagePaths(MAX_KNOWLEDGE_FILES + 1);
    const { repo, calls } = build(paths);

    await repo.listFiles('r1');

    expect(calls).toHaveLength(2);
    expect(calls[0].where).toEqual({ repoId: 'r1' });
    expect(calls[0].take).toBe(MAX_KNOWLEDGE_FILES);
    expect(calls[0].orderBy).toEqual({ path: 'asc' });
    expect(calls[1].where).toEqual({ repoId: 'r1', path: { gt: paths[MAX_KNOWLEDGE_FILES - 1] } });
    expect(calls[1].take).toBe(MAX_KNOWLEDGE_FILES);
  });

  it('does not stop early on a page that is exactly full when nothing follows it', async () => {
    const { repo, findMany } = build(pagePaths(MAX_KNOWLEDGE_FILES));

    const files = await repo.listFiles('r1');

    expect(files).toHaveLength(MAX_KNOWLEDGE_FILES);
    // The next page is empty, so the walk asks once more instead of assuming the corpus ended.
    expect(findMany).toHaveBeenCalledTimes(2);
  });
});

/**
 * US-002: the project's saved patterns row and the patterns snapshot of an index row. The Prisma client is faked
 * again (no database); the same contract is pinned against Postgres in
 * test/integration/fleet/knowledge-store.integration.spec.ts.
 */
interface PatternRow {
  projectId: string;
  patterns: unknown;
  updatedAt: Date;
}

interface IndexRow {
  repoId: string;
  projectId: string;
  patternsKey?: string | null;
  [field: string]: unknown;
}

/** The two delegates the pattern and state contract touches, over in-memory maps. */
function patternClient(seed: Record<string, unknown> = {}): {
  client: unknown;
  patterns: Map<string, PatternRow>;
  index: Map<string, IndexRow>;
} {
  const patterns = new Map<string, PatternRow>(
    Object.entries(seed).map(([projectId, value]) => [projectId, { projectId, patterns: value, updatedAt: new Date(0) }]),
  );
  const index = new Map<string, IndexRow>();
  const client = {
    knowledgeProjectPatterns: {
      findUnique: async ({ where }: { where: { projectId: string } }) => patterns.get(where.projectId) ?? null,
      upsert: async ({ where, create, update }: { where: { projectId: string }; create: { patterns: unknown }; update: { patterns: unknown } }) => {
        const existing = patterns.get(where.projectId);
        const row = { projectId: where.projectId, patterns: (existing ? update : create).patterns, updatedAt: new Date() };
        patterns.set(where.projectId, row);
        return row;
      },
      deleteMany: async ({ where }: { where: { projectId: string } }) => ({ count: patterns.delete(where.projectId) ? 1 : 0 }),
    },
    knowledgeRepoIndex: {
      upsert: async ({ where, create, update }: { where: { repoId: string }; create: IndexRow; update: IndexRow }) => {
        const existing = index.get(where.repoId);
        const row = { ...(existing ? { ...existing, ...update } : create) };
        index.set(where.repoId, row);
        return row;
      },
      findMany: async ({ where }: { where: { projectId: string } }) => [...index.values()].filter((row) => row.projectId === where.projectId),
    },
  };
  return { client, patterns, index };
}

function buildPatternRepo(seed: Record<string, unknown> = {}) {
  const backing = patternClient(seed);
  const repo = new PrismaKnowledgeIndexRepository({ client: backing.client } as unknown as PrismaService<PrismaClient>);
  return { repo, ...backing };
}

const FINISH_BASE = { projectId: 'p1', fileCount: 1, chunkCount: 3, unembeddedCount: 0, skippedCount: 0, lastError: null, finishedAt: new Date('2026-10-21T00:00:00Z') };

describe('PrismaKnowledgeIndexRepository project patterns (US-002)', () => {
  it('AC-11: saveProjectPatterns round-trips a list, and null deletes the row', async () => {
    const { repo, patterns } = buildPatternRepo();

    await repo.saveProjectPatterns('p1', ['a/*.md']);
    expect(await repo.findProjectPatterns('p1')).toEqual(['a/*.md']);

    await repo.saveProjectPatterns('p1', null);
    expect(await repo.findProjectPatterns('p1')).toBeNull();
    expect(patterns.size).toBe(0);
  });

  it('upserts the row for a project that already saved a list and leaves other projects alone', async () => {
    const { repo, patterns } = buildPatternRepo({ p2: ['docs/*.md'] });

    await repo.saveProjectPatterns('p1', ['a/*.md']);
    await repo.saveProjectPatterns('p1', ['b/*.md']);

    expect(await repo.findProjectPatterns('p1')).toEqual(['b/*.md']);
    expect(await repo.findProjectPatterns('p2')).toEqual(['docs/*.md']);
    expect(patterns.size).toBe(2);
  });

  it('answers null for a project that never saved patterns and for a row that is not a string list', async () => {
    const { repo } = buildPatternRepo({ corrupt: { not: 'a list' } });

    expect(await repo.findProjectPatterns('missing')).toBeNull();
    expect(await repo.findProjectPatterns('corrupt')).toBeNull();
  });

  it('drops a non-string entry from a stored list instead of handing it to the selector', async () => {
    const { repo } = buildPatternRepo({ p1: ['a/*.md', 7] });

    expect(await repo.findProjectPatterns('p1')).toEqual(['a/*.md']);
  });

  it('AC-11: finish writes the pass patternsKey and listStates reads it back', async () => {
    const { repo } = buildPatternRepo();

    await repo.finish('r1', { ...FINISH_BASE, status: 'idle', patternsKey: 'x' });

    expect(await repo.listStates('p1')).toEqual([expect.objectContaining({ repoId: 'r1', patternsKey: 'x', fileCount: 1 })]);
  });

  it('finish without a patternsKey keeps the stored one, so a failed pass never clears the snapshot', async () => {
    const { repo } = buildPatternRepo();

    await repo.finish('r1', { ...FINISH_BASE, status: 'idle', patternsKey: 'handbook/*.md' });
    await repo.finish('r1', { ...FINISH_BASE, status: 'failed', lastError: 'boom' });

    expect(await repo.listStates('p1')).toEqual([expect.objectContaining({ patternsKey: 'handbook/*.md', status: 'failed', lastError: 'boom' })]);
  });

  it('finish writes an explicit null, so a project that cleared its patterns records the default key', async () => {
    const { repo } = buildPatternRepo();

    await repo.finish('r1', { ...FINISH_BASE, status: 'idle', patternsKey: 'handbook/*.md' });
    await repo.finish('r1', { ...FINISH_BASE, status: 'idle', patternsKey: null });

    expect(await repo.listStates('p1')).toEqual([expect.objectContaining({ patternsKey: null })]);
  });
});

/**
 * Fleet S5b US-004/AC-14/AC-15 — the read the outcome pass projects. The Prisma client is faked here so the
 * epoch selection and the row mapping run without a database; the PG round-trip (constraints, `take`, the
 * real `orderBy`) lives in test/integration/fleet/knowledge-store.integration.spec.ts.
 */
describe('PrismaKnowledgeIndexRepository.findRunOutcomes (S5b US-004)', () => {
  const JOB_ROW = {
    id: 'j1', projectId: 'p1', repoId: 'r1', feature: 'f', resultSha: 'abc1234',
    repo: { owner: 'o', name: 'n' },
  };
  type Row = { kind: string; content: string };

  /** The three delegates the read touches: the job, its newest successful ingest, and that epoch's rows. */
  function build(over: { job?: unknown; latest?: unknown; rows?: Row[] } = {}) {
    const findUnique = vi.fn(async () => (over.job === undefined ? JOB_ROW : over.job));
    const findFirst = vi.fn(async () => (over.latest === undefined ? { leaseEpoch: 2 } : over.latest));
    const findMany = vi.fn(async () => over.rows ?? [{ kind: 'report', content: '# R' }, { kind: 'decisions', content: '{"id":"D-1"}' }]);
    const repo = new PrismaKnowledgeIndexRepository({
      client: { fleetJob: { findUnique }, fleetBundleIngest: { findFirst }, fleetRunOutcome: { findMany } },
    } as unknown as PrismaService<PrismaClient>);
    return { repo, findUnique, findFirst, findMany };
  }

  it('AC-14: reads the highest successfully ingested epoch and its rows, report first', async () => {
    const { repo, findFirst, findMany } = build({ rows: [{ kind: 'decisions', content: '{"id":"D-1"}' }, { kind: 'report', content: '# R' }] });

    const found = await repo.findRunOutcomes('j1');

    expect(found?.job).toEqual({ id: 'j1', projectId: 'p1', repoId: 'r1', feature: 'f', resultSha: 'abc1234', owner: 'o', name: 'n' });
    expect(found?.outcomes).toEqual([{ kind: 'report', content: '# R' }, { kind: 'decisions', content: '{"id":"D-1"}' }]);
    expect(findFirst).toHaveBeenCalledWith({
      where: { jobId: 'j1', status: { in: ['done', 'partial'] } }, orderBy: { leaseEpoch: 'desc' }, take: 1, select: { leaseEpoch: true },
    });
    expect(findMany).toHaveBeenCalledWith({
      where: { jobId: 'j1', leaseEpoch: 2 }, orderBy: { kind: 'asc' }, take: 2, select: { kind: true, content: true },
    });
  });

  it('AC-15: answers an empty outcome list when the latest epoch carries no outcome row', async () => {
    const { repo, findMany } = build({ rows: [] });

    expect((await repo.findRunOutcomes('j1'))?.outcomes).toEqual([]);
    expect(findMany).toHaveBeenCalledTimes(1);
  });

  it('answers empty without reading outcome rows when the job never ingested successfully', async () => {
    const { repo, findMany } = build({ latest: null });

    expect((await repo.findRunOutcomes('j1'))?.outcomes).toEqual([]);
    expect(findMany).not.toHaveBeenCalled();
  });

  it('answers null for an unknown job and reads no ingest or outcome row', async () => {
    const { repo, findFirst, findMany } = build({ job: null });

    expect(await repo.findRunOutcomes('missing')).toBeNull();
    expect(findFirst).not.toHaveBeenCalled();
    expect(findMany).not.toHaveBeenCalled();
  });

  it('drops a row whose kind is neither outcome file', async () => {
    const { repo } = build({ rows: [{ kind: 'other', content: 'x' }, { kind: 'report', content: '# R' }] });

    expect((await repo.findRunOutcomes('j1'))?.outcomes).toEqual([{ kind: 'report', content: '# R' }]);
  });

  it('reports a null resultSha as null, not as an empty string', async () => {
    const { repo } = build({ job: { ...JOB_ROW, resultSha: null } });

    expect((await repo.findRunOutcomes('j1'))?.job.resultSha).toBeNull();
  });
});

/**
 * Fleet S5b US-005/AC-10 — the bounded job and PR read the outcome fence makes (3c-2-D4). The Prisma client is
 * faked here so the two queries, their caps and the first-link-per-job choice run without a database, and the fake
 * honours the `where`, `orderBy` and `take` it is handed; the real ordering on Postgres lives in
 * test/integration/fleet/knowledge-store.integration.spec.ts.
 */
describe('PrismaKnowledgeIndexRepository.describeJobs (S5b US-005)', () => {
  interface JobRow {
    id: string;
    projectId: string;
    repoId: string;
    feature: string;
    state: string;
    resultPrUrl: string | null;
  }

  interface LinkRow {
    id: string;
    jobId: string | null;
    prState: string | null;
    prUpdatedAt: Date | null;
    source: string;
  }

  /** `prUpdatedAt` desc then `id`, the ordering of the query: Postgres puts NULLs first on a DESC order. */
  function byPrUpdatedAtThenId(a: LinkRow, b: LinkRow): number {
    if (a.prUpdatedAt !== b.prUpdatedAt) {
      if (a.prUpdatedAt === null) return -1;
      if (b.prUpdatedAt === null) return 1;
      return a.prUpdatedAt > b.prUpdatedAt ? -1 : 1;
    }
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  }

  function build(seed: { jobs?: JobRow[]; links?: LinkRow[] } = {}) {
    const jobs: JobRow[] = seed.jobs ?? [];
    const links: LinkRow[] = seed.links ?? [];
    const jobFindMany = vi.fn(async (args: { where: { id: { in: string[] }; projectId: string }; take: number }) =>
      jobs.filter((row) => args.where.id.in.includes(row.id) && row.projectId === args.where.projectId).slice(0, args.take));
    const linkFindMany = vi.fn(async (args: { where: { jobId: { in: string[] } }; take: number }) =>
      links
        .filter((row) => row.jobId !== null && args.where.jobId.in.includes(row.jobId) && row.source === 'fleet' && row.prState !== null)
        .sort(byPrUpdatedAtThenId)
        .slice(0, args.take));
    const repo = new PrismaKnowledgeIndexRepository({
      client: { fleetJob: { findMany: jobFindMany }, ticketLink: { findMany: linkFindMany } },
    } as unknown as PrismaService<PrismaClient>);
    return { repo, jobFindMany, linkFindMany };
  }

  const jobRow = (over: Partial<JobRow> = {}): JobRow => ({
    id: 'j1', projectId: 'p1', repoId: 'r1', feature: 'f', state: 'COMPLETED', resultPrUrl: 'https://github.com/o/n/pull/9', ...over,
  });

  const linkRow = (over: Partial<LinkRow> = {}): LinkRow => ({
    id: 'l1', jobId: 'j1', prState: 'open', prUpdatedAt: new Date('2026-10-20T10:00:00.000Z'), source: 'fleet', ...over,
  });

  it('AC-10: answers a job of the project with its current state and newest fleet PR state', async () => {
    const { repo, jobFindMany, linkFindMany } = build({
      jobs: [jobRow()],
      links: [
        linkRow({ id: 'l1', prState: 'open', prUpdatedAt: new Date('2026-10-20T10:00:00.000Z') }),
        linkRow({ id: 'l2', prState: 'merged', prUpdatedAt: new Date('2026-10-21T10:00:00.000Z') }),
      ],
    });

    expect(await repo.describeJobs('p1', ['j1'])).toEqual([
      { jobId: 'j1', repoId: 'r1', feature: 'f', state: 'COMPLETED', prUrl: 'https://github.com/o/n/pull/9', prState: 'merged' },
    ]);
    expect(jobFindMany).toHaveBeenCalledWith({
      where: { id: { in: ['j1'] }, projectId: 'p1' },
      take: 200,
      select: { id: true, repoId: true, feature: true, state: true, resultPrUrl: true },
    });
    expect(linkFindMany).toHaveBeenCalledWith({
      where: { jobId: { in: ['j1'] }, source: 'fleet', prState: { not: null } },
      orderBy: [{ prUpdatedAt: 'desc' }, { id: 'asc' }],
      take: 1000,
      select: { jobId: true, prState: true },
    });
  });

  it('AC-10: omits a job of another project, as the query does', async () => {
    const { repo } = build({
      jobs: [jobRow(), jobRow({ id: 'j2', projectId: 'p2' })],
      links: [linkRow(), linkRow({ id: 'l2', jobId: 'j2' })],
    });

    expect(await repo.describeJobs('p1', ['j1', 'j2'])).toEqual([
      { jobId: 'j1', repoId: 'r1', feature: 'f', state: 'COMPLETED', prUrl: 'https://github.com/o/n/pull/9', prState: 'open' },
    ]);
  });

  it('answers no info for an unknown job id and reads the links of the ids it was given', async () => {
    const { repo, linkFindMany } = build({ jobs: [] });

    expect(await repo.describeJobs('p1', ['missing'])).toEqual([]);
    expect(linkFindMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ jobId: { in: ['missing'] } }) }));
  });

  it('runs no query for an empty id list', async () => {
    const { repo, jobFindMany, linkFindMany } = build({ jobs: [jobRow()] });

    expect(await repo.describeJobs('p1', [])).toEqual([]);
    expect(jobFindMany).not.toHaveBeenCalled();
    expect(linkFindMany).not.toHaveBeenCalled();
  });

  it('answers a null prState for a job whose fleet links carry none', async () => {
    const { repo } = build({
      jobs: [jobRow({ resultPrUrl: null })],
      links: [linkRow({ prState: null }), linkRow({ id: 'l2', prState: 'open', source: 'vcs' })],
    });

    expect(await repo.describeJobs('p1', ['j1'])).toEqual([
      { jobId: 'j1', repoId: 'r1', feature: 'f', state: 'COMPLETED', prUrl: null, prState: null },
    ]);
  });

  it('keeps the newest link per job when several jobs are described at once', async () => {
    const { repo } = build({
      jobs: [jobRow(), jobRow({ id: 'j2', state: 'FAILED' })],
      links: [
        linkRow({ id: 'l1', jobId: 'j1', prState: 'open' }),
        linkRow({ id: 'l2', jobId: 'j2', prState: 'closed', prUpdatedAt: new Date('2026-10-22T10:00:00.000Z') }),
        linkRow({ id: 'l3', jobId: 'j2', prState: 'draft', prUpdatedAt: new Date('2026-10-19T10:00:00.000Z') }),
      ],
    });

    expect((await repo.describeJobs('p1', ['j1', 'j2'])).map((info) => [info.jobId, info.prState])).toEqual([
      ['j1', 'open'], ['j2', 'closed'],
    ]);
  });

  it('breaks an equal prUpdatedAt by link id ascending', async () => {
    const same = new Date('2026-10-20T10:00:00.000Z');
    const { repo } = build({
      jobs: [jobRow()],
      links: [linkRow({ id: 'lb', prState: 'closed', prUpdatedAt: same }), linkRow({ id: 'la', prState: 'merged', prUpdatedAt: same })],
    });

    expect((await repo.describeJobs('p1', ['j1']))[0].prState).toBe('merged');
  });
});
