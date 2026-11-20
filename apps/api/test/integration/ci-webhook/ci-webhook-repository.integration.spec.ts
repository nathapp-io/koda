import { Test, TestingModule } from '@nestjs/testing';
import { PrismaModule, PrismaService } from '@nathapp/nestjs-prisma';
import { PrismaClient } from '../../../src/generated/prisma/client';
import { PrismaCiWebhookRepository } from '../../../src/ci-webhook/prisma-ci-webhook.repository';
import { createPgAdapter } from '../../../src/prisma/pg-adapter';
import { canRunDbTests } from '../../helpers/test-environment';
import { resetDb } from '../../helpers/reset-db';

const describeIntegration = canRunDbTests() ? describe : describe.skip;
const DATABASE_URL = process.env.DATABASE_URL;

describeIntegration('PrismaCiWebhookRepository', () => {
  let module: TestingModule;
  let prisma: PrismaService<PrismaClient>;
  let repository: PrismaCiWebhookRepository;

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
      providers: [PrismaCiWebhookRepository],
    }).compile();
    prisma = module.get<PrismaService<PrismaClient>>(PrismaService);
    await prisma.onModuleInit();
    repository = module.get(PrismaCiWebhookRepository);
  });

  afterAll(async () => {
    await module?.close();
  });

  it('AC-8: selects gitRemoteUrl from the project', async () => {
    const project = await prisma.client.project.create({
      data: {
        name: 'CI webhook repository test',
        slug: 'ci-webhook-repository-test',
        key: 'CWR',
        gitRemoteUrl: 'https://github.com/acme/app',
      },
    });

    await expect(repository.findProjectBySlug(project.slug)).resolves.toMatchObject({
      id: project.id,
      gitRemoteUrl: 'https://github.com/acme/app',
    });
  });
});
