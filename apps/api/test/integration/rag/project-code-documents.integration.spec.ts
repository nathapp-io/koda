import { canRunDbTests } from '../../helpers/test-environment';
/**
 * The entity warmup must page through only the project’s GraphNode modules.
 *
 * Run: cd apps/api && bun run test:integration -- test/integration/rag/project-code-documents.integration.spec.ts
 */
import { Test, TestingModule } from '@nestjs/testing';
import { PrismaModule, PrismaService } from '@nathapp/nestjs-prisma';
import { PrismaClient } from '../../../src/generated/prisma/client';
import { PrismaRagRepository } from '../../../src/rag/prisma-rag.repository';
import { resetDb } from '../../helpers/reset-db';
import { createPgAdapter } from '../../../src/prisma/pg-adapter';

const DATABASE_URL = process.env.DATABASE_URL;
// The nax sandbox withholds host Postgres/Docker.
const describeIntegration = canRunDbTests() ? describe : describe.skip;

describeIntegration('PrismaRagRepository.scanCodeModules', () => {
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
          clientOptions: { adapter: createPgAdapter(DATABASE_URL) },
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

  it('reads ordered, bounded pages of projected code modules for one project', async () => {
    const a = await prisma.client.project.create({ data: { name: 'A', slug: 'gn-a', key: 'GNA' } });
    const b = await prisma.client.project.create({ data: { name: 'B', slug: 'gn-b', key: 'GNB' } });
    await prisma.client.graphNode.createMany({
      data: [
        ...Array.from({ length: 501 }, (_, index) => {
          const nodeId = `mod:${String(index).padStart(3, '0')}`;
          return { projectId: a.id, nodeId, label: nodeId, type: 'code_module', sourceFile: 'src/auth.ts' };
        }),
        { projectId: a.id, nodeId: 'note:1', label: 'loose node', type: null, sourceFile: null },
        { projectId: b.id, nodeId: 'mod:other', label: 'other', type: 'code_module', sourceFile: 'x.ts' },
      ],
    });

    const pages: Array<Array<{ nodeId: string; label: string }>> = [];
    await repo.scanCodeModules(a.id, page => { pages.push(page); });

    expect(pages.map(page => page.length)).toEqual([500, 1]);
    expect(pages[0][0]).toEqual({ nodeId: 'mod:000', label: 'mod:000' });
    expect(pages[0][499]).toEqual({ nodeId: 'mod:499', label: 'mod:499' });
    expect(pages[1][0]).toEqual({ nodeId: 'mod:500', label: 'mod:500' });
  });
});
