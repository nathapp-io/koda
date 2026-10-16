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
