/**
 * M6 — concurrent ticket creation must yield distinct, gapless numbers on
 * Postgres through every allocator (tickets service path, CI webhook, VCS import).
 *
 * Run: cd apps/api && bun run test:integration -- test/integration/tickets/ticket-number-allocation.integration.spec.ts
 */
import { Test, TestingModule } from '@nestjs/testing';
import { PrismaModule, PrismaService } from '@nathapp/nestjs-prisma';
import { ITransactionManager, TRANSACTION_MANAGER } from '@nathapp/nestjs-data';
import { PrismaClient } from '@prisma/client';
import { PrismaCiWebhookRepository } from '../../../src/ci-webhook/prisma-ci-webhook.repository';
import { PrismaVcsRepository } from '../../../src/vcs/prisma-vcs.repository';
import { PrismaTicketsRepository } from '../../../src/tickets/prisma-tickets.repository';
import { runWithTicketNumberRetry } from '../../../src/common/utils/ticket-number-retry';
import { resetDb } from '../../helpers/reset-db';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;
const N = 10;

describeIntegration('M6 ticket-number allocation under concurrency', () => {
  let module: TestingModule;
  let prisma: PrismaService<PrismaClient>;
  let txManager: ITransactionManager;
  let ciRepo: PrismaCiWebhookRepository;
  let vcsRepo: PrismaVcsRepository;
  let ticketRepo: PrismaTicketsRepository;

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
      providers: [PrismaCiWebhookRepository, PrismaVcsRepository, PrismaTicketsRepository],
    }).compile();

    prisma = module.get<PrismaService<PrismaClient>>(PrismaService);
    await prisma.onModuleInit();
    txManager = module.get<ITransactionManager>(TRANSACTION_MANAGER);
    ciRepo = module.get(PrismaCiWebhookRepository);
    vcsRepo = module.get(PrismaVcsRepository);
    ticketRepo = module.get(PrismaTicketsRepository);
  });

  afterAll(async () => {
    await module?.close();
  });

  async function newProject(key: string): Promise<string> {
    const p = await prisma.client.project.create({
      data: { name: key, slug: key.toLowerCase(), key },
    });
    return p.id;
  }

  async function numbersOf(projectId: string): Promise<number[]> {
    const rows = await prisma.client.ticket.findMany({
      where: { projectId },
      select: { number: true },
      orderBy: { number: 'asc' },
    });
    return rows.map((r) => r.number);
  }

  const expected = Array.from({ length: N }, (_, i) => i + 1);

  it('tickets-service path (repository + helper) allocates 1..N', async () => {
    const projectId = await newProject('SVC');
    await Promise.all(
      Array.from({ length: N }, (_, i) =>
        runWithTicketNumberRetry(txManager, async () => {
          const last = await ticketRepo.findLastTicketInProject(projectId);
          return ticketRepo.createTicket({
            projectId,
            number: (last?.number ?? 0) + 1,
            type: 'TASK',
            title: `t${i}`,
            description: null,
            status: 'CREATED',
            priority: 'MEDIUM',
            createdByUserId: null,
            createdByAgentId: null,
          });
        }),
      ),
    );
    expect(await numbersOf(projectId)).toEqual(expected);
  });

  it('CI webhook allocator allocates 1..N', async () => {
    const projectId = await newProject('CIW');
    await Promise.all(
      Array.from({ length: N }, (_, i) =>
        ciRepo.createTicket(projectId, {
          type: 'BUG',
          title: `ci${i}`,
          description: 'd',
          status: 'CREATED',
          priority: 'HIGH',
          gitRefVersion: 'abc',
          gitRefFile: null,
          gitRefLine: null,
        }),
      ),
    );
    expect(await numbersOf(projectId)).toEqual(expected);
  });

  it('VCS import allocator allocates 1..N', async () => {
    const projectId = await newProject('VCS');
    await Promise.all(
      Array.from({ length: N }, (_, i) =>
        vcsRepo.createTicketFromIssue(
          { id: projectId },
          {
            number: i + 1,
            title: `issue${i}`,
            body: null,
            authorLogin: 'octo',
            url: `https://example.test/${i}`,
            labels: [],
            createdAt: new Date(),
          },
        ),
      ),
    );
    expect(await numbersOf(projectId)).toEqual(expected);
  });
});
