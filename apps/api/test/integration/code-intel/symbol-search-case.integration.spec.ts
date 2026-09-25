/**
 * The historical SQLite LIKE was ASCII case-insensitive; Postgres `contains` is not.
 * Symbol search must keep matching regardless of case.
 *
 * Run: cd apps/api && bun run test:integration -- test/integration/code-intel/symbol-search-case.integration.spec.ts
 */
import { Test, TestingModule } from '@nestjs/testing';
import { PrismaModule, PrismaService } from '@nathapp/nestjs-prisma';
import { PrismaClient } from '@prisma/client';
import { PrismaCodeIntelRepository } from '../../../src/code-intel/prisma-code-intel.repository';
import { resetDb } from '../../helpers/reset-db';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;

describeIntegration('symbol search case sensitivity', () => {
  let module: TestingModule;
  let prisma: PrismaService<PrismaClient>;
  let repo: PrismaCodeIntelRepository;
  let projectId: string;

  beforeAll(async () => {
    await resetDb();
    module = await Test.createTestingModule({
      imports: [
        PrismaModule.forRoot({
          client: PrismaClient,
          transaction: true,
          clientOptions: { datasources: { db: { url: DATABASE_URL } } },
        }),
      ],
      providers: [PrismaCodeIntelRepository],
    }).compile();
    prisma = module.get<PrismaService<PrismaClient>>(PrismaService);
    await prisma.onModuleInit();
    repo = module.get(PrismaCodeIntelRepository);

    const project = await prisma.client.project.create({ data: { name: 'S', slug: 'sym', key: 'SYM' } });
    projectId = project.id;
    await prisma.client.symbol.create({
      data: {
        id: 'r1:src/auth/UserService.ts::UserService',
        symbolId: 'src/auth/UserService.ts::UserService',
        projectId,
        repoId: 'r1',
        commitHash: 'abc',
        name: 'UserService',
        kind: 'class',
        file: 'src/auth/UserService.ts',
        startLine: 1,
        endLine: 10,
      },
    });
  });

  afterAll(async () => {
    await module?.close();
  });

  it('matches name regardless of case', async () => {
    const res = await repo.searchSymbols(projectId, { q: 'userservice' });
    expect(res.total).toBe(1);
    expect(res.items[0].name).toBe('UserService');
  });

  it('matches file regardless of case', async () => {
    const res = await repo.searchSymbols(projectId, { file: 'SRC/AUTH' });
    expect(res.total).toBe(1);
  });
});
