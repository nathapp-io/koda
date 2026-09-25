/**
 * M14 — getProjectCodeDocuments must read GraphNode rows (the code_document
 * table never existed).
 *
 * Run: cd apps/api && bun run test:integration -- test/integration/rag/project-code-documents.integration.spec.ts
 */
import { Test, TestingModule } from '@nestjs/testing';
import { PrismaModule, PrismaService } from '@nathapp/nestjs-prisma';
import { PrismaClient } from '@prisma/client';
import { PrismaRagRepository } from '../../../src/rag/prisma-rag.repository';
import { resetDb } from '../../helpers/reset-db';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;

describeIntegration('PrismaRagRepository.getProjectCodeDocuments (M14)', () => {
  let module: TestingModule;
  let prisma: PrismaService<PrismaClient>;
  let repo: PrismaRagRepository;

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
      providers: [PrismaRagRepository],
    }).compile();
    prisma = module.get<PrismaService<PrismaClient>>(PrismaService);
    await prisma.onModuleInit();
    repo = module.get(PrismaRagRepository);
  });

  afterAll(async () => {
    await module?.close();
  });

  it('maps GraphNode rows of the project, including null type/sourceFile', async () => {
    const a = await prisma.client.project.create({ data: { name: 'A', slug: 'gn-a', key: 'GNA' } });
    const b = await prisma.client.project.create({ data: { name: 'B', slug: 'gn-b', key: 'GNB' } });
    await prisma.client.graphNode.createMany({
      data: [
        { projectId: a.id, nodeId: 'mod:auth', label: 'auth module', type: 'code_module', sourceFile: 'src/auth.ts' },
        { projectId: a.id, nodeId: 'note:1', label: 'loose node', type: null, sourceFile: null },
        { projectId: b.id, nodeId: 'mod:other', label: 'other', type: 'code_module', sourceFile: 'x.ts' },
      ],
    });

    const rows = await repo.getProjectCodeDocuments(a.id);
    const byId = Object.fromEntries(rows.map((r) => [r.id, r]));

    expect(rows).toHaveLength(2);
    expect(byId['mod:auth']).toEqual({ id: 'mod:auth', label: 'auth module', type: 'code_module', source_file: 'src/auth.ts' });
    expect(byId['note:1']).toEqual({ id: 'note:1', label: 'loose node', type: '', source_file: undefined });
  });
});
