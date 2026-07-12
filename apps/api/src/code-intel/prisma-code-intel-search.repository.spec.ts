import { PrismaService } from '@nathapp/nestjs-prisma';
import type { PrismaClient } from '@prisma/client';
import { PrismaCodeIntelRepository } from './prisma-code-intel.repository';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePrismaService(overrides: {
  symbolFindMany?: jest.Mock;
  symbolCount?: jest.Mock;
} = {}): PrismaService<PrismaClient> {
  const symbolFindMany = overrides.symbolFindMany ?? jest.fn().mockResolvedValue([]);
  const symbolCount = overrides.symbolCount ?? jest.fn().mockResolvedValue(0);

  return {
    client: {
      symbol: {
        findMany: symbolFindMany,
        count: symbolCount,
      },
    },
  } as unknown as PrismaService<PrismaClient>;
}

// Calls the not-yet-existing searchSymbols method via optional chaining so tests
// fail at the assertion rather than throwing a "not a function" runtime error.
async function callSearchSymbols(
  repo: PrismaCodeIntelRepository,
  projectId: string,
  opts: { q?: string; file?: string; page?: number; limit?: number },
) {
  return (repo as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>)[
    'searchSymbols'
  ]?.(projectId, opts);
}

// ---------------------------------------------------------------------------
// Suite: AC9 — PrismaCodeIntelRepository.searchSymbols Prisma call shape
// ---------------------------------------------------------------------------

describe('PrismaCodeIntelRepository.searchSymbols()', () => {
  let mockSymbolFindMany: jest.Mock;
  let mockSymbolCount: jest.Mock;
  let repo: PrismaCodeIntelRepository;

  beforeEach(() => {
    mockSymbolFindMany = jest.fn().mockResolvedValue([]);
    mockSymbolCount = jest.fn().mockResolvedValue(0);
    repo = new PrismaCodeIntelRepository(makePrismaService({
      symbolFindMany: mockSymbolFindMany,
      symbolCount: mockSymbolCount,
    }));
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // AC9: where clause — projectId always present
  // -------------------------------------------------------------------------

  it('AC9: issues symbol.findMany with projectId in where clause', async () => {
    await callSearchSymbols(repo, 'proj-1', { page: 1, limit: 20 });

    expect(mockSymbolFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ projectId: 'proj-1' }),
      }),
    );
  });

  // -------------------------------------------------------------------------
  // AC9: where clause — name contains when q is provided
  // -------------------------------------------------------------------------

  it('AC9: includes name contains filter when q is provided', async () => {
    await callSearchSymbols(repo, 'proj-1', { q: 'myFunc', page: 1, limit: 20 });

    expect(mockSymbolFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          name: { contains: 'myFunc' },
        }),
      }),
    );
  });

  it('AC9 boundary: omits name filter when q is not provided', async () => {
    await callSearchSymbols(repo, 'proj-1', { page: 1, limit: 20 });

    // findMany must have been called once (fails if method not implemented)
    expect(mockSymbolFindMany).toHaveBeenCalledTimes(1);
    const whereArg = (mockSymbolFindMany.mock.calls[0]?.[0] as { where?: Record<string, unknown> } | undefined)?.where;
    expect(whereArg).not.toHaveProperty('name');
  });

  // -------------------------------------------------------------------------
  // AC9: where clause — file contains when file is provided
  // -------------------------------------------------------------------------

  it('AC9: includes file contains filter when file is provided', async () => {
    await callSearchSymbols(repo, 'proj-1', { file: 'src/auth', page: 1, limit: 20 });

    expect(mockSymbolFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          file: { contains: 'src/auth' },
        }),
      }),
    );
  });

  it('AC9 boundary: omits file filter when file is not provided', async () => {
    await callSearchSymbols(repo, 'proj-1', { page: 1, limit: 20 });

    expect(mockSymbolFindMany).toHaveBeenCalledTimes(1);
    const whereArg = (mockSymbolFindMany.mock.calls[0]?.[0] as { where?: Record<string, unknown> } | undefined)?.where;
    expect(whereArg).not.toHaveProperty('file');
  });

  // -------------------------------------------------------------------------
  // AC9: pagination — take and skip derived from page and limit
  // -------------------------------------------------------------------------

  it('AC9: applies take=20 and skip=0 for page=1, limit=20', async () => {
    await callSearchSymbols(repo, 'proj-1', { page: 1, limit: 20 });

    expect(mockSymbolFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 20, skip: 0 }),
    );
  });

  it('AC9: applies take=20 and skip=20 for page=2, limit=20', async () => {
    await callSearchSymbols(repo, 'proj-1', { page: 2, limit: 20 });

    expect(mockSymbolFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 20, skip: 20 }),
    );
  });

  it('AC9: applies take=10 and skip=20 for page=3, limit=10', async () => {
    await callSearchSymbols(repo, 'proj-1', { page: 3, limit: 10 });

    expect(mockSymbolFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 10, skip: 20 }),
    );
  });

  // -------------------------------------------------------------------------
  // AC9: return shape — { items, total }
  // -------------------------------------------------------------------------

  it('AC9: returns { items, total } with matching rows', async () => {
    const rows = [
      {
        id: 'repo:src/a.ts::Foo',
        symbolId: 'repo:src/a.ts::Foo',
        projectId: 'proj-1',
        repoId: 'repo-1',
        commitHash: 'abc',
        name: 'Foo',
        kind: 'function',
        file: 'src/a.ts',
        startLine: 1,
        endLine: 5,
        signature: null,
        callers: [],
        callees: [],
        docComment: null,
      },
    ];
    mockSymbolFindMany.mockResolvedValue(rows);
    mockSymbolCount.mockResolvedValue(1);

    const result = await callSearchSymbols(repo, 'proj-1', { q: 'Foo', page: 1, limit: 20 });

    expect(result).toMatchObject({ items: rows, total: 1 });
  });

  it('AC9 boundary: returns { items: [], total: 0 } when no symbols match', async () => {
    mockSymbolFindMany.mockResolvedValue([]);
    mockSymbolCount.mockResolvedValue(0);

    const result = await callSearchSymbols(repo, 'proj-1', { q: 'zzz-no-match', page: 1, limit: 20 });

    expect(result).toMatchObject({ items: [], total: 0 });
  });

  it('AC9: total reflects count query, not items array length', async () => {
    const rows = [
      {
        id: 'sym-1', symbolId: 'sym-1', projectId: 'proj-1', repoId: 'r',
        commitHash: 'abc', name: 'Foo', kind: 'function', file: 'src/a.ts',
        startLine: 1, endLine: 5, signature: null, callers: [], callees: [], docComment: null,
      },
    ];
    mockSymbolFindMany.mockResolvedValue(rows);
    mockSymbolCount.mockResolvedValue(99);

    const result = await callSearchSymbols(repo, 'proj-1', { q: 'Foo', page: 2, limit: 1 });

    expect((result as { total?: number })?.total).toBe(99);
  });

  // -------------------------------------------------------------------------
  // AC9: both q and file filters combined
  // -------------------------------------------------------------------------

  it('AC9: applies both name and file contains when q and file are provided together', async () => {
    await callSearchSymbols(repo, 'proj-1', { q: 'Service', file: 'src/auth', page: 1, limit: 20 });

    expect(mockSymbolFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          name: { contains: 'Service' },
          file: { contains: 'src/auth' },
        }),
      }),
    );
  });
});
