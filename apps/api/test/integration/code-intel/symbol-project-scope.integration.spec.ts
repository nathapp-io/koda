/**
 * Track 3 Slice 4 (M13): two projects indexing the same repository keep their
 * own symbols; a re-upsert never moves a row to another project.
 * Run: cd apps/api && bun run test:db:up && bun run test:scoped test/integration/code-intel/symbol-project-scope.integration.spec.ts
 */
import { PrismaClient } from '@prisma/client';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { PrismaCodeIntelRepository } from '../../../src/code-intel/prisma-code-intel.repository';
import { symbolFullId } from '../../../src/code-intel/symbol-id';
import type { SymbolData } from '../../../src/code-intel/symbol-store';
import { resetDb } from '../../helpers/reset-db';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;

describeIntegration('Symbol ids are project-scoped (M13)', () => {
  jest.setTimeout(20000);
  let prismaService: PrismaService<PrismaClient>;
  let prisma: PrismaClient;
  let repo: PrismaCodeIntelRepository;
  let p1: string;
  let p2: string;

  const symbol = (projectId: string, name: string, startLine = 1): SymbolData => {
    const id = symbolFullId(projectId, 'acme/widgets', 'src/a.ts', 'alpha');
    return {
      id, symbolId: id, projectId, repoId: 'acme/widgets', commitHash: 'c1', name, kind: 'function',
      file: 'src/a.ts', startLine, endLine: startLine + 1, callers: [], callees: [],
    };
  };

  beforeAll(async () => {
    if (!DATABASE_URL) return;
    await resetDb(DATABASE_URL);
    prismaService = new PrismaService({ client: PrismaClient, clientOptions: { datasources: { db: { url: DATABASE_URL } } } });
    await prismaService.onModuleInit();
    prisma = prismaService.client;
    repo = new PrismaCodeIntelRepository(prismaService);
    p1 = (await prisma.project.create({ data: { name: 'One', slug: 'one', key: 'ONE' } })).id;
    p2 = (await prisma.project.create({ data: { name: 'Two', slug: 'two', key: 'TWO' } })).id;
  });

  afterAll(async () => {
    if (prismaService) await prismaService.onModuleDestroy();
  });

  it('keeps both projects\' copies of the same repo symbol', async () => {
    await repo.upsertSymbol(symbol(p1, 'alpha'));
    await repo.upsertSymbol(symbol(p2, 'alpha'));

    const rows = await prisma.symbol.findMany({ where: { name: 'alpha' }, orderBy: { projectId: 'asc' } });
    expect(rows.map((r) => r.projectId).sort()).toEqual([p1, p2].sort());
  });

  it('a re-index updates in place and never moves the row to another project', async () => {
    await repo.upsertSymbol(symbol(p1, 'alpha', 40));

    const row = await prisma.symbol.findUniqueOrThrow({
      where: { projectId_symbolId: { projectId: p1, symbolId: symbolFullId(p1, 'acme/widgets', 'src/a.ts', 'alpha') } },
    });
    expect(row.startLine).toBe(40);
    expect(row.projectId).toBe(p1);
    expect(await prisma.symbol.count({ where: { projectId: p2 } })).toBe(1);
  });
});
